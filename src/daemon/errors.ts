import { RpcErrorCode, type RpcErrorData } from "../protocol/index.js";
import { DaemonDisconnectedError, RpcError, type UserAction, type UserFacingError } from "./types.js";

const COMMAND_REAUTH = "mailcoded.reauthAccount";
const COMMAND_REFRESH = "mailcoded.refresh";
const COMMAND_SEND = "mailcoded.send";
const COMMAND_SHOW_LOG = "mailcoded.showDaemonLog";
const COMMAND_RESTART = "mailcoded.restartDaemon";

const SHOW_LOG: UserAction = { title: "Show Daemon Log", command: COMMAND_SHOW_LOG };
const RESTART_DAEMON: UserAction = { title: "Restart Daemon", command: COMMAND_RESTART };
const REFRESH: UserAction = { title: "Refresh", command: COMMAND_REFRESH };
const PREVIEW_AGAIN: UserAction = { title: "Preview Again", command: COMMAND_SEND };

const NO_ACTIONS: readonly UserAction[] = [];

export interface ErrorContext {
  readonly accountId?: number | undefined;
  /** The account's own address, never a correspondent's and never anything from a message. */
  readonly accountName?: string | undefined;
  readonly storePath?: string | undefined;
  /** A fixed developer-written label such as "Sync"; never a request param or mail content. */
  readonly operation?: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function toErrorData(value: unknown): RpcErrorData | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const data: RpcErrorData = {};
  const category = record["category"];
  if (typeof category === "string") {
    data.category = category;
  }
  const detail = record["detail"];
  if (typeof detail === "string") {
    data.detail = detail;
  }
  const retryAfterMs = record["retryAfterMs"];
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    data.retryAfterMs = retryAfterMs;
  }
  if (record["requiresUserAction"] === true) {
    data.requiresUserAction = true;
  }
  const accountId = record["accountId"];
  if (typeof accountId === "number" && Number.isFinite(accountId)) {
    data.accountId = accountId;
  }
  const folderId = record["folderId"];
  if (typeof folderId === "number" && Number.isFinite(folderId)) {
    data.folderId = folderId;
  }
  return data;
}

/** Accepts the library's `ResponseError` structurally, so this layer never leaks one upward. */
export function fromResponseError(error: unknown): RpcError {
  if (error instanceof RpcError) {
    return error;
  }
  const record = asRecord(error);
  const rawCode = record?.["code"];
  const code = typeof rawCode === "number" ? rawCode : RpcErrorCode.InternalError;
  const rawMessage = record?.["message"];
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : "The daemon returned an error.";
  return new RpcError(code, message, toErrorData(record?.["data"]));
}

export { fromResponseError as toRpcError };

export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError;
}

export function isDisconnected(error: unknown): error is DaemonDisconnectedError {
  return error instanceof DaemonDisconnectedError;
}

export function isTransient(error: unknown): boolean {
  return error instanceof RpcError && error.isTransient;
}

/** A closed gate. No retry opens one, and no RPC opens one either. */
export function isGate(error: unknown): boolean {
  return error instanceof RpcError && error.isGate;
}

export function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof RpcError)) {
    return undefined;
  }
  const hinted = error.retryAfterMs;
  return hinted !== undefined && Number.isFinite(hinted) && hinted > 0 ? hinted : undefined;
}

export function retryDelayMs(error: unknown, attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  const hinted = retryAfterMs(error);
  if (hinted !== undefined) {
    return Math.min(hinted, maxMs);
  }
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
  return Math.round(exponential * (0.5 + Math.random() / 2));
}

function seconds(ms: number | undefined): number | undefined {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : undefined;
}

function sentence(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");
}

function accountLabel(error: RpcError, context: ErrorContext): string {
  const name = context.accountName?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const id = error.accountId ?? context.accountId;
  return id === undefined ? "your mail account" : `account ${id}`;
}

function reauthAction(error: RpcError, context: ErrorContext): UserAction {
  const id = error.accountId ?? context.accountId;
  return id === undefined
    ? { title: "Update Password", command: COMMAND_REAUTH }
    : { title: "Update Password", command: COMMAND_REAUTH, args: [id] };
}

function prefix(context: ErrorContext): string | undefined {
  const operation = context.operation?.trim();
  return operation !== undefined && operation.length > 0 ? `${operation} failed.` : undefined;
}

function clientBug(error: RpcError, context: ErrorContext): UserFacingError {
  return {
    text: join(
      prefix(context),
      `Mailcoded sent a request the daemon rejected (code ${error.code}).`,
      "That is a bug in the extension rather than something you can fix; the daemon log has the detail.",
      sentence(error.detail),
    ),
    actions: [SHOW_LOG],
  };
}

/** Every branch is on the numeric code; `message` and `data.detail` are the only safe strings. */
export function explain(error: unknown, context: ErrorContext = {}): UserFacingError {
  if (error instanceof DaemonDisconnectedError) {
    return {
      text: join(
        prefix(context),
        "The connection to the mailcoded daemon is gone and cannot be reused.",
        "Restarting the daemon reconnects it.",
      ),
      actions: [RESTART_DAEMON, SHOW_LOG],
    };
  }

  if (!(error instanceof RpcError)) {
    return {
      text: join(prefix(context), "Mailcoded hit an unexpected error. The daemon log has the detail."),
      actions: [SHOW_LOG],
    };
  }

  switch (error.code) {
    case RpcErrorCode.Auth:
      return {
        text: join(
          `Signing in to ${accountLabel(error, context)} failed.`,
          "Mailcoded has stopped trying, because repeated attempts can lock an account.",
          "Enter the password or app password again to continue.",
          sentence(error.detail),
        ),
        actions: [reauthAction(error, context)],
      };

    case RpcErrorCode.Network: {
      const wait = seconds(error.retryAfterMs);
      return {
        text: join(
          "Lost contact with the mail server.",
          wait === undefined ? "Reconnecting." : `Reconnecting in ${wait} ${wait === 1 ? "second" : "seconds"}.`,
        ),
        actions: NO_ACTIONS,
      };
    }

    case RpcErrorCode.NotFound:
      return {
        text: join(
          prefix(context),
          "That item is no longer where Mailcoded expected it — a sync moved or removed it.",
          "Refresh the list to pick up the change.",
          sentence(error.detail),
        ),
        actions: [REFRESH],
      };

    case RpcErrorCode.ConfirmRequired:
      return {
        text: join(
          "This message needs a fresh preview before it can be sent:",
          "the one-time send token was used already or has expired.",
          "Preview it again, read it, then send.",
        ),
        actions: [PREVIEW_AGAIN],
      };

    case RpcErrorCode.StoreCorrupt:
      return {
        text: join(
          "The local mail store failed an integrity check, so Mailcoded has stopped writing to it.",
          "The recovery is a re-sync from the server, which restores mail but not local Tags or the outbox.",
          sentence(error.detail),
        ),
        actions: [SHOW_LOG],
      };

    case RpcErrorCode.RateLimited: {
      const wait = seconds(error.retryAfterMs);
      return {
        text: join(
          "The mail server is rate-limiting Mailcoded.",
          wait === undefined ? "Waiting before trying again." : `Waiting ${wait} ${wait === 1 ? "second" : "seconds"} before trying again.`,
        ),
        actions: NO_ACTIONS,
      };
    }

    case RpcErrorCode.Forbidden:
      return {
        text: join(
          "A mailcoded safety gate refused this:",
          sentence(error.detail ?? error.message),
          "This extension cannot open a gate — it has to be changed where the daemon runs, in its settings or environment.",
        ),
        actions: [SHOW_LOG],
      };

    case RpcErrorCode.StoreFull:
      return {
        text: join(
          "The disk holding the mail store is full, so syncing is paused rather than risking the store.",
          context.storePath === undefined ? undefined : `Store: ${context.storePath}.`,
          sentence(error.detail),
          "Free some space, then try again.",
        ),
        actions: [SHOW_LOG],
      };

    case RpcErrorCode.Unsupported:
      return {
        text: join(
          prefix(context),
          "This account cannot do that — the server or this daemon build lacks the capability.",
          "Mailcoded will not offer it for this account again.",
          sentence(error.detail),
        ),
        actions: NO_ACTIONS,
      };

    case RpcErrorCode.ParseError:
      return {
        text: join(
          "The connection to the mailcoded daemon is out of step and it has stopped reading.",
          "Restarting the daemon is the only recovery.",
        ),
        actions: [RESTART_DAEMON, SHOW_LOG],
      };

    case RpcErrorCode.InvalidRequest:
    case RpcErrorCode.MethodNotFound:
    case RpcErrorCode.InvalidParams:
      return clientBug(error, context);

    case RpcErrorCode.InternalError:
      return {
        text: join(
          prefix(context),
          "The daemon hit an internal error. Mailcoded will try once more; if it happens again, the daemon log has the stack trace.",
          sentence(error.detail),
        ),
        actions: [SHOW_LOG],
      };

    default:
      return {
        text: join(prefix(context), `${error.message} (code ${error.code})`, error.detail),
        actions: [SHOW_LOG],
      };
  }
}
