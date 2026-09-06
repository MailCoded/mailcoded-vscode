import * as vscode from "vscode";

import type { EnvelopeDto, FolderDto } from "../protocol/index.js";
import type {
  DaemonNotification,
  Event,
  FolderUpdatedEvent,
  MailAddedEvent,
  SyncErrorEvent,
} from "./types.js";

export const NOTIFICATION_METHODS = [
  "notify.mail.added",
  "notify.folder.updated",
  "notify.sync.error",
] as const;

export type NotificationMethod = (typeof NOTIFICATION_METHODS)[number];

export function isNotificationMethod(method: string): method is NotificationMethod {
  return (NOTIFICATION_METHODS as readonly string[]).includes(method);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isEnvelope(value: unknown): value is EnvelopeDto {
  const record = asRecord(value);
  return record !== undefined && num(record, "id") !== undefined;
}

function toEnvelopes(value: unknown): readonly EnvelopeDto[] {
  return Array.isArray(value) && value.every(isEnvelope) ? value : [];
}

function toFolder(value: unknown): FolderDto | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const id = num(record, "id");
  const accountId = num(record, "accountId");
  const name = str(record, "name");
  const unread = num(record, "unread");
  const total = num(record, "total");
  if (id === undefined || accountId === undefined || name === undefined) {
    return undefined;
  }
  const folder: FolderDto = { id, accountId, name, unread: unread ?? 0, total: total ?? 0 };
  const role = str(record, "role");
  if (role !== undefined) {
    folder.role = role;
  }
  return folder;
}

function parseMailAdded(record: Record<string, unknown>): MailAddedEvent | undefined {
  const accountId = num(record, "accountId");
  const folderId = num(record, "folderId");
  const count = num(record, "count");
  const folderName = str(record, "folderName");
  if (accountId === undefined || folderId === undefined || count === undefined) {
    return undefined;
  }
  // An unusable envelope array becomes empty rather than dropping the arrival: `coalesced` then
  // tells the consumer to refresh with `search`, which is the one path that cannot lose mail.
  const messages = toEnvelopes(record["messages"]);
  return {
    accountId,
    folderId,
    folderName: folderName ?? "",
    count,
    messages,
    coalesced: count > messages.length,
  };
}

function parseFolderUpdated(record: Record<string, unknown>): FolderUpdatedEvent | undefined {
  const accountId = num(record, "accountId");
  const folder = toFolder(record["folder"]);
  if (accountId === undefined || folder === undefined) {
    return undefined;
  }
  return { accountId, folder };
}

function parseSyncError(record: Record<string, unknown>): SyncErrorEvent | undefined {
  const accountId = num(record, "accountId");
  const code = num(record, "code");
  const message = str(record, "message");
  if (accountId === undefined || code === undefined || message === undefined) {
    return undefined;
  }
  const event: SyncErrorEvent = {
    accountId,
    code,
    message,
    requiresUserAction: record["requiresUserAction"] === true,
    atUtc: str(record, "atUtc") ?? new Date().toISOString(),
  };
  const folderId = num(record, "folderId");
  if (folderId !== undefined) {
    event.folderId = folderId;
  }
  const category = str(record, "category");
  if (category !== undefined) {
    event.category = category;
  }
  const retryAfterMs = num(record, "retryAfterMs");
  if (retryAfterMs !== undefined) {
    event.retryAfterMs = retryAfterMs;
  }
  return event;
}

/** A malformed notification is dropped, never thrown: the daemon expects no answer to one. */
export function parseNotification(method: string, params: unknown): DaemonNotification | undefined {
  const record = asRecord(params);
  if (record === undefined) {
    return undefined;
  }
  switch (method) {
    case "notify.mail.added": {
      const parsed = parseMailAdded(record);
      return parsed === undefined ? undefined : { method, params: parsed };
    }
    case "notify.folder.updated": {
      const parsed = parseFolderUpdated(record);
      return parsed === undefined ? undefined : { method, params: parsed };
    }
    case "notify.sync.error": {
      const parsed = parseSyncError(record);
      return parsed === undefined ? undefined : { method, params: parsed };
    }
    default:
      return undefined;
  }
}

/** Fans one interleaved stream out to three typed events without reordering it. */
export class NotificationRouter implements vscode.Disposable {
  private readonly anyEmitter = new vscode.EventEmitter<DaemonNotification>();
  private readonly mailAddedEmitter = new vscode.EventEmitter<MailAddedEvent>();
  private readonly folderUpdatedEmitter = new vscode.EventEmitter<FolderUpdatedEvent>();
  private readonly syncErrorEmitter = new vscode.EventEmitter<SyncErrorEvent>();

  readonly onNotification: Event<DaemonNotification> = this.anyEmitter.event;
  readonly onMailAdded: Event<MailAddedEvent> = this.mailAddedEmitter.event;
  readonly onFolderUpdated: Event<FolderUpdatedEvent> = this.folderUpdatedEmitter.event;
  readonly onSyncError: Event<SyncErrorEvent> = this.syncErrorEmitter.event;

  handle(method: string, params: unknown): boolean {
    const notification = parseNotification(method, params);
    if (notification === undefined) {
      return false;
    }
    this.dispatch(notification);
    return true;
  }

  dispatch(notification: DaemonNotification): void {
    this.anyEmitter.fire(notification);
    switch (notification.method) {
      case "notify.mail.added":
        this.mailAddedEmitter.fire(notification.params);
        return;
      case "notify.folder.updated":
        this.folderUpdatedEmitter.fire(notification.params);
        return;
      case "notify.sync.error":
        this.syncErrorEmitter.fire(notification.params);
        return;
    }
  }

  dispose(): void {
    this.anyEmitter.dispose();
    this.mailAddedEmitter.dispose();
    this.folderUpdatedEmitter.dispose();
    this.syncErrorEmitter.dispose();
  }
}
