import type { Readable, Writable } from "node:stream";

import type {
  AccountDto,
  CapabilitiesDto,
  FolderDto,
  FolderUpdatedNotification,
  HealthDto,
  MailAddedNotification,
  RpcErrorData,
  RpcMethodMap,
  RpcMethodName,
  StatsDto,
  SyncErrorNotification,
} from "../protocol/index.js";
import { RpcErrorCode } from "../protocol/index.js";

/** Structurally the `vscode` shapes, redeclared so this layer stays loadable in plain Node. */
export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export const CLIENT_NAME = "mailcoded-vscode";

/** Not an agent surface: `rpc` earns HTML bodies and `message.move` without the agent unlocks. */
export const CLIENT_INTERFACE = "rpc";

export const DAEMON_EXECUTABLE_NAME = "mailcoded-daemon";

export const DAEMON_EXECUTABLE_ENV_VAR = "MAILCODED_DAEMON";

/** Carries daemon stderr only, which the daemon has already redacted. Nothing we send goes here. */
export const DAEMON_OUTPUT_CHANNEL_NAME = "Mailcoded Daemon";

export type DaemonState =
  | "stopped"
  | "starting"
  | "ready"
  | "secondary"
  | "restarting"
  | "failed"
  | "daemonMissing"
  | "protocolMismatch";

/** Live session. `secondary` is `ready` minus notifications: another mailcoded owns the store lock. */
export interface ConnectedDaemonStatus {
  readonly state: "ready" | "secondary";
  readonly capabilities: CapabilitiesDto;
  readonly daemonVersion: string;
  readonly detail?: string;
}

export interface UnconnectedDaemonStatus {
  readonly state: Exclude<DaemonState, "ready" | "secondary">;
  readonly detail?: string;
}

export type DaemonStatus = ConnectedDaemonStatus | UnconnectedDaemonStatus;

export type DaemonLocationSource = "setting" | "env" | "bundled" | "path";

/** Which candidate won, so the log can say why this executable and not another. */
export interface DaemonLocation {
  readonly file: string;
  readonly source: DaemonLocationSource;
}

/** Stable numeric code from docs/rpc.md §6.1: branch on `code`, never on `message`. */
export class RpcError extends Error {
  readonly code: number;
  readonly category: string | undefined;
  readonly detail: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requiresUserAction: boolean;
  readonly accountId: number | undefined;
  readonly folderId: number | undefined;

  constructor(code: number, message: string, data?: RpcErrorData) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.category = data?.category;
    this.detail = data?.detail;
    this.retryAfterMs = data?.retryAfterMs;
    this.requiresUserAction = data?.requiresUserAction === true;
    this.accountId = data?.accountId;
    this.folderId = data?.folderId;
  }

  /** Worth retrying after a backoff that honours `retryAfterMs`. */
  get isTransient(): boolean {
    return this.code === RpcErrorCode.Network || this.code === RpcErrorCode.RateLimited;
  }

  /** No amount of retrying opens a gate, and there is no RPC that opens one. */
  get isGate(): boolean {
    return this.code === RpcErrorCode.Forbidden || this.code === RpcErrorCode.ConfirmRequired;
  }
}

/** The pipe is spent: a faulted stream or a dead child recovers only by respawning. */
export class DaemonDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonDisconnectedError";
  }
}

export interface UserAction {
  readonly title: string;
  readonly command?: string;
  readonly args?: readonly unknown[];
}

/** What `errors.ts` produces, so no caller ever builds a message string from a raw code. */
export interface UserFacingError {
  readonly text: string;
  readonly actions: readonly UserAction[];
}

export interface MailAddedEvent extends MailAddedNotification {
  /** `count > messages.length`: the array was capped, so refresh with `search` instead of trusting it. */
  readonly coalesced: boolean;
}

export type FolderUpdatedEvent = FolderUpdatedNotification;

export type SyncErrorEvent = SyncErrorNotification;

/** One stream so the interleaving the daemon chose survives to the consumer. */
export type DaemonNotification =
  | { readonly method: "notify.mail.added"; readonly params: MailAddedEvent }
  | { readonly method: "notify.folder.updated"; readonly params: FolderUpdatedEvent }
  | { readonly method: "notify.sync.error"; readonly params: SyncErrorEvent };

export interface DaemonExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Latched once and never cleared; every later request on the same pipe fails with it. */
export interface DaemonFault {
  readonly reason: string;
  readonly code?: number;
}

export interface DaemonProcess extends Disposable {
  readonly location: DaemonLocation;
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Already redacted by the daemon and safe to surface; the owner must consume it or the pipe stalls. */
  readonly onStderrLine: Event<string>;
  readonly onExit: Event<DaemonExit>;
  /** Idempotent, and must leave no child behind: close stdin, wait briefly, then kill. */
  dispose(): void;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

export interface DaemonConnection extends Disposable {
  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RpcMethodMap[M]["result"]>;
  readonly onNotification: Event<DaemonNotification>;
  readonly onFault: Event<DaemonFault>;
  readonly fault: DaemonFault | undefined;
  dispose(): void;
}

export interface MailcodedClient extends Disposable {
  readonly capabilities: CapabilitiesDto;
  readonly daemonVersion: string;
  /** `capabilities.methods` is authoritative; an absent method is an absent feature. */
  supports(method: RpcMethodName): boolean;
  /** Capability-gated: rejects with `RpcError` 1008 rather than calling an unadvertised method. */
  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RpcMethodMap[M]["result"]>;
  accountList(): Promise<readonly AccountDto[]>;
  folderList(accountId: number): Promise<readonly FolderDto[]>;
  stats(): Promise<StatsDto>;
  health(): Promise<HealthDto>;
  shutdown(): Promise<void>;
  dispose(): void;
}

export interface DaemonSupervisor extends Disposable {
  readonly status: DaemonStatus;
  readonly onDidChangeStatus: Event<DaemonStatus>;
  /** Stable across restarts, unlike the connection that emitted the underlying frame. */
  readonly onNotification: Event<DaemonNotification>;
  /** Throws `DaemonDisconnectedError` unless the state is `ready` or `secondary`. */
  readonly client: MailcodedClient;
  start(): Promise<void>;
  restart(): Promise<void>;
  dispose(): void;
}

export type RequestTimeoutTable = Readonly<Partial<Record<RpcMethodName, number>>> & {
  readonly default: number;
};

/** A sync or an account add runs for minutes, so the 30 s default would kill a healthy one;
 * shutdown gets 2 s because the daemon answers before it drains. */
export const REQUEST_TIMEOUTS_MS: RequestTimeoutTable = {
  default: 30_000,
  sync: 600_000,
  "account.add": 600_000,
  "message.get": 60_000,
  "attachment.get": 60_000,
  shutdown: 2_000,
};
