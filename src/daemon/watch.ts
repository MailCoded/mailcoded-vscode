import * as vscode from "vscode";

import { hardenLine } from "../model/messageFormat.js";
import type { AccountDto } from "../protocol/index.js";
import { RpcErrorCode } from "../protocol/index.js";

import { isDisconnected, isRpcError } from "./errors.js";
import type { MailcodedDaemonSupervisor } from "./supervisor.js";
import type { DaemonStatus, SyncErrorEvent } from "./types.js";

const LOG_PREFIX = "[watch]";
const SYNC_ERROR_MAX = 120;
const CATEGORY_MAX = 24;

/** rpc.md §4: empty means the account's own configured watch set, which is INBOX unless the
 * account says otherwise. Choosing folders here would override the user's configuration. */
const CONFIGURED_FOLDERS: readonly number[] = [];

export interface MailWatcher extends vscode.Disposable {
  /** Accounts with an accepted subscription on the daemon process that is running now. */
  readonly watching: readonly number[];
  /** Resolves once the pass started by the most recent status change has settled. */
  settled(): Promise<void>;
}

/** Nothing in `notify.*` arrives until a client asks for it (rpc.md §5), so without this the
 * extension's whole notification path — trees, badge, status bar — is never fed. */
class MailWatch implements MailWatcher {
  readonly #supervisor: MailcodedDaemonSupervisor;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #watching = new Set<number>();
  #generation = 0;
  #pass: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(supervisor: MailcodedDaemonSupervisor) {
    this.#supervisor = supervisor;
    this.#subscriptions.push(
      supervisor.onDidChangeStatus((status) => {
        this.#onStatus(status);
      }),
      supervisor.onNotification((notification) => {
        if (notification.method === "notify.sync.error") {
          this.#logSyncError(notification.params);
        }
      }),
    );
    this.#onStatus(supervisor.status);
  }

  get watching(): readonly number[] {
    return [...this.#watching];
  }

  settled(): Promise<void> {
    return this.#pass;
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#watching.clear();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
  }

  /** A subscription lives in the daemon process, so any transition at all invalidates every one
   * of them; the generation is what stops a pass from outliving the connection it was made on. */
  #onStatus(status: DaemonStatus): void {
    if (this.#disposed) {
      return;
    }
    this.#generation += 1;
    this.#watching.clear();

    if (status.state !== "ready") {
      if (status.state === "secondary") {
        this.#log("not watching: another daemon owns the store, so no notification would arrive");
      }
      return;
    }
    if (!status.capabilities.watch) {
      this.#log("not watching: this daemon does not offer the watch capability");
      return;
    }

    const generation = this.#generation;
    this.#pass = this.#subscribeAll(generation);
  }

  async #subscribeAll(generation: number): Promise<void> {
    let accounts: readonly AccountDto[];
    try {
      accounts = await this.#supervisor.client.accountList();
    } catch (error: unknown) {
      this.#report("could not list the accounts to watch", error);
      return;
    }

    for (const account of accounts) {
      if (generation !== this.#generation) {
        return;
      }
      try {
        await this.#supervisor.client.request("watch.subscribe", {
          accountId: account.id,
          folderIds: CONFIGURED_FOLDERS,
        });
      } catch (error: unknown) {
        // No retry, by design. A refusal here means a dead credential, a store this daemon does
        // not own, or an absent capability, and asking again forever is the bug that has already
        // been made twice in this project.
        this.#report(`watch.subscribe for account ${String(account.id)} was refused`, error);
        if (isDisconnected(error)) {
          return;
        }
        continue;
      }
      if (generation === this.#generation) {
        this.#watching.add(account.id);
      }
    }

    if (generation === this.#generation) {
      this.#log(`watching ${String(this.#watching.size)} of ${String(accounts.length)} account(s) for new mail`);
    }
  }

  #report(what: string, error: unknown): void {
    if (isDisconnected(error)) {
      this.#log(`${what}: the daemon connection is gone`);
      return;
    }
    if (isRpcError(error)) {
      const inert = error.code === RpcErrorCode.Unsupported ? " (this daemon will not watch this store)" : "";
      this.#log(`${what}: code ${String(error.code)}${inert}`);
      return;
    }
    this.#log(what);
  }

  /** The only trace a user has that a background sync is failing. rpc.md §5 guarantees this
   * payload carries no credential and no mail content; it is hardened anyway. */
  #logSyncError(event: SyncErrorEvent): void {
    const folder = event.folderId === undefined ? "" : ` folder ${String(event.folderId)}`;
    const category = event.category === undefined ? "" : ` ${hardenLine(event.category, CATEGORY_MAX)}`;
    const attention = event.requiresUserAction ? ", needs attention" : "";
    const detail = hardenLine(event.message, SYNC_ERROR_MAX);
    this.#log(
      `sync error on account ${String(event.accountId)}${folder}: code ${String(event.code)}` +
        `${category}${attention}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  #log(message: string): void {
    try {
      this.#supervisor.output.appendLine(`${LOG_PREFIX} ${message}`);
    } catch {
      return;
    }
  }
}

export function createMailWatcher(supervisor: MailcodedDaemonSupervisor): MailWatcher {
  return new MailWatch(supervisor);
}
