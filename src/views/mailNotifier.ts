import * as vscode from "vscode";

import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import type { MailAddedEvent } from "../daemon/types.js";
import { hardenLine, senderLabel } from "../model/messageFormat.js";
import type { EnvelopeDto } from "../protocol/index.js";

import type { FolderScope } from "./messagesTree.js";

/** Long enough that one IDLE burst is one message, short enough to still feel like an alert. */
const COALESCE_MS = 4_000;
/** A busy mailbox must not be able to queue a toast per arrival. */
const QUIET_MS = 20_000;
const FOLDERS_MAX = 32;

const FOLDER_MAX = 40;
const SENDER_MAX = 40;
const SUBJECT_MAX = 60;
const NO_SUBJECT = "(no subject)";
const SOMEWHERE = "your mail";
const SHOW = "Show";

export interface FolderArrival {
  readonly accountId: number;
  readonly folderId: number;
  readonly folderName: string;
  readonly count: number;
  /** Absent when the batch was coalesced past its envelope cap, or carried no envelopes. */
  readonly newest?: EnvelopeDto;
}

export interface NewMailNotifier extends vscode.Disposable {
  /** How many summaries have been shown, for tests. */
  readonly shown: number;
}

export interface NewMailNotifierOptions {
  readonly supervisor: MailcodedDaemonSupervisor;
  /** What the `Show` button does. Given numbers and a folder name, never mail text. */
  readonly reveal: (scope: FolderScope) => void;
  /** Read at flush time, so turning the setting off silences a burst already in flight. */
  readonly enabled: () => boolean;
  readonly now?: () => number;
  readonly coalesceMs?: number;
  readonly quietMs?: number;
}

/** Pure, so the wording is a unit test rather than a screenshot. Every value it interpolates was
 * chosen by whoever sent the mail, so every value goes through `hardenLine` first. */
export function newMailSummary(arrivals: readonly FolderArrival[]): string | undefined {
  const folders = arrivals.filter((arrival) => arrival.count > 0);
  const first = folders[0];
  if (first === undefined) {
    return undefined;
  }

  const total = folders.reduce((sum, arrival) => sum + arrival.count, 0);
  if (folders.length > 1) {
    return `${String(total)} new messages in ${String(folders.length)} folders`;
  }

  const where = hardenLine(first.folderName, FOLDER_MAX) || SOMEWHERE;
  if (total === 1 && first.newest !== undefined) {
    const who = hardenLine(senderLabel(first.newest), SENDER_MAX);
    const what = hardenLine(first.newest.subject, SUBJECT_MAX) || NO_SUBJECT;
    return `New mail in ${where} from ${who}: ${what}`;
  }
  return `${String(total)} new ${total === 1 ? "message" : "messages"} in ${where}`;
}

function arrivalDate(envelope: EnvelopeDto): number {
  const parsed = Date.parse(envelope.date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newest(batch: readonly EnvelopeDto[], against: EnvelopeDto | undefined): EnvelopeDto | undefined {
  let best = against;
  for (const envelope of batch) {
    if (best === undefined || arrivalDate(envelope) >= arrivalDate(best)) {
      best = envelope;
    }
  }
  return best;
}

function busiest(arrivals: readonly FolderArrival[]): FolderArrival | undefined {
  let best: FolderArrival | undefined;
  for (const arrival of arrivals) {
    if (best === undefined || arrival.count > best.count) {
      best = arrival;
    }
  }
  return best;
}

class Notifier implements NewMailNotifier {
  readonly #options: NewMailNotifierOptions;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #pending = new Map<string, FolderArrival>();
  readonly #now: () => number;
  readonly #coalesceMs: number;
  readonly #quietMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastShownAt = 0;
  #shown = 0;
  #disposed = false;

  constructor(options: NewMailNotifierOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.#quietMs = options.quietMs ?? QUIET_MS;
    this.#subscriptions.push(
      options.supervisor.onNotification((notification) => {
        if (notification.method === "notify.mail.added") {
          this.#arrived(notification.params);
        }
      }),
    );
  }

  get shown(): number {
    return this.#shown;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pending.clear();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
  }

  #arrived(event: MailAddedEvent): void {
    if (this.#disposed || event.count <= 0) {
      return;
    }

    const key = `${String(event.accountId)}:${String(event.folderId)}`;
    const held = this.#pending.get(key);
    if (held === undefined && this.#pending.size >= FOLDERS_MAX) {
      return;
    }

    // `count` is the truth and `messages` is a capped sample (rpc.md §5), so the total comes from
    // the count and the headline from whichever envelope did arrive.
    const merged = newest(event.messages, held?.newest);
    this.#pending.set(key, {
      accountId: event.accountId,
      folderId: event.folderId,
      folderName: event.folderName,
      count: (held?.count ?? 0) + event.count,
      ...(merged === undefined ? {} : { newest: merged }),
    });
    this.#arm();
  }

  #arm(): void {
    if (this.#timer !== undefined) {
      return;
    }
    const quietUntil = this.#lastShownAt + this.#quietMs;
    const wait = Math.max(this.#coalesceMs, quietUntil - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, wait);
  }

  #flush(): void {
    const arrivals = [...this.#pending.values()];
    this.#pending.clear();
    if (this.#disposed || arrivals.length === 0) {
      return;
    }
    // Dropped rather than deferred: the badge and the trees have already shown the arrival, and a
    // toast that appears minutes after the setting was turned off is worse than none.
    if (!this.#options.enabled()) {
      return;
    }

    const summary = newMailSummary(arrivals);
    const target = busiest(arrivals);
    if (summary === undefined || target === undefined) {
      return;
    }

    this.#lastShownAt = this.#now();
    this.#shown += 1;
    const scope: FolderScope = {
      accountId: target.accountId,
      folderId: target.folderId,
      folderName: target.folderName,
    };
    void Promise.resolve(vscode.window.showInformationMessage(summary, SHOW)).then(
      (choice) => {
        if (choice === SHOW && !this.#disposed) {
          this.#options.reveal(scope);
        }
      },
      () => undefined,
    );
  }
}

export function createNewMailNotifier(options: NewMailNotifierOptions): NewMailNotifier {
  return new Notifier(options);
}
