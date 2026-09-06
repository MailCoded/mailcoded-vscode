import * as vscode from "vscode";

import { explain, isRpcError } from "../daemon/errors.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import type { DaemonStatus } from "../daemon/types.js";
import type { AccountDto } from "../protocol/index.js";
import { RpcErrorCode } from "../protocol/index.js";
import type { FolderTreeNode } from "../views/accountsTree.js";
import type { MailcodedStatusBar } from "../views/statusBar.js";
import { harden } from "../views/treeItems.js";

export const COMMAND_SHOW_DAEMON_LOG = "mailcoded.showDaemonLog";
export const COMMAND_SHOW_DAEMON_INFO = "mailcoded.showDaemonInfo";
export const COMMAND_RESTART_DAEMON = "mailcoded.restartDaemon";
export const COMMAND_REFRESH = "mailcoded.refresh";
export const COMMAND_SYNC = "mailcoded.sync";
export const COMMAND_SYNC_FOLDER = "mailcoded.syncFolder";

const SHOW_LOG = "Show Daemon Log";

/** Structural on purpose: the commands need the tree's cache cleared, not its node type. */
export interface RefreshableTree {
  refresh(): void;
}

export interface CommandDependencies {
  readonly tree: RefreshableTree;
  readonly statusBar: MailcodedStatusBar;
}

interface FolderTarget {
  readonly accountId: number;
  readonly folderId: number;
  readonly label: string;
}

function connected(status: DaemonStatus): status is Extract<DaemonStatus, { state: "ready" | "secondary" }> {
  return status.state === "ready" || status.state === "secondary";
}

function describe(status: DaemonStatus): string {
  const detail = status.detail;
  return `The mailcoded daemon is ${status.state}.${detail === undefined ? "" : ` ${detail}`}`;
}

async function offerLog(supervisor: MailcodedDaemonSupervisor, message: string, warn: boolean): Promise<void> {
  const chosen = warn
    ? await vscode.window.showWarningMessage(message, SHOW_LOG)
    : await vscode.window.showInformationMessage(message, SHOW_LOG);
  if (chosen === SHOW_LOG) {
    supervisor.output.show(true);
  }
}

function isAuthFailure(error: unknown): boolean {
  return isRpcError(error) && error.code === RpcErrorCode.Auth;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isFolderNode(value: unknown): value is FolderTreeNode {
  const ref = asRecord(value);
  return (
    ref?.["kind"] === "folder" &&
    typeof ref["accountId"] === "number" &&
    asRecord(ref["node"]) !== undefined
  );
}

/** A group row carries no folder of its own, so there is nothing on the server to sync. */
function folderTarget(node: unknown): FolderTarget | undefined {
  if (!isFolderNode(node)) {
    return undefined;
  }
  const folder = node.node.folder;
  return folder === undefined
    ? undefined
    : { accountId: node.accountId, folderId: folder.id, label: harden(folder.name) };
}

async function restartDaemon(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Restarting the mailcoded daemon" },
      () => supervisor.restart(),
    );
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Restarting the daemon" }).text, true);
    return;
  }

  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), true);
  }
}

async function showDaemonInfo(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), false);
    return;
  }

  let accounts: number;
  try {
    accounts = (await supervisor.client.accountList()).length;
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
    return;
  }

  const { capabilities } = status;
  const parts = [
    `Daemon ${status.daemonVersion}`,
    `${String(capabilities.methods.length)} methods`,
    `max search ${String(capabilities.maxSearchLimit)}`,
    `${String(accounts)} ${accounts === 1 ? "account" : "accounts"}`,
  ];
  if (status.state === "secondary") {
    parts.push("secondary instance, no notifications");
  }

  await offerLog(supervisor, parts.join(" · "), false);
}

async function syncAccounts(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
): Promise<void> {
  let accounts: readonly AccountDto[];
  try {
    accounts = await supervisor.client.accountList();
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
    return;
  }

  if (accounts.length === 0) {
    await vscode.window.showInformationMessage("There are no mail accounts to sync yet.");
    return;
  }

  const token = deps.statusBar.beginSync();
  let firstFailure: string | undefined;
  let authFailed = false;
  try {
    for (const account of accounts) {
      try {
        await supervisor.client.request("sync", { accountId: account.id });
      } catch (error: unknown) {
        authFailed = authFailed || isAuthFailure(error);
        firstFailure ??= explain(error, {
          operation: `Syncing ${account.email}`,
          accountId: account.id,
          accountName: account.email,
        }).text;
      }
    }
  } finally {
    token.dispose();
  }

  if (authFailed) {
    deps.statusBar.setNeedsSignIn(true);
  } else if (firstFailure === undefined) {
    deps.statusBar.setNeedsSignIn(false);
  }

  deps.tree.refresh();

  if (firstFailure !== undefined) {
    await offerLog(supervisor, firstFailure, true);
  }
}

async function syncFolder(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  node: unknown,
): Promise<void> {
  const target = folderTarget(node);
  if (target === undefined) {
    await vscode.window.showInformationMessage(
      "Sync Folder runs on one folder. Right-click a folder in the Mailcoded accounts view and choose it there.",
    );
    return;
  }

  const token = deps.statusBar.beginSync();
  let failure: string | undefined;
  try {
    await supervisor.client.request("sync", { accountId: target.accountId, folderId: target.folderId });
  } catch (error: unknown) {
    if (isAuthFailure(error)) {
      deps.statusBar.setNeedsSignIn(true);
    }
    failure = explain(error, { operation: `Syncing ${target.label}`, accountId: target.accountId }).text;
  } finally {
    token.dispose();
  }

  if (failure !== undefined) {
    await offerLog(supervisor, failure, true);
    return;
  }

  deps.statusBar.setNeedsSignIn(false);
  deps.tree.refresh();
}

/** Every declared command is registered here; a palette entry that answers "command not found"
 * is worse than an absent one, so the manifest and this list are checked against each other. */
export function registerCommands(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_LOG, () => {
      supervisor.output.show(true);
    }),
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_INFO, () => showDaemonInfo(supervisor)),
    vscode.commands.registerCommand(COMMAND_RESTART_DAEMON, () => restartDaemon(supervisor)),
    vscode.commands.registerCommand(COMMAND_REFRESH, () => {
      deps.tree.refresh();
    }),
    vscode.commands.registerCommand(COMMAND_SYNC, () => syncAccounts(supervisor, deps)),
    vscode.commands.registerCommand(COMMAND_SYNC_FOLDER, (node: unknown) => syncFolder(supervisor, deps, node)),
  );
}
