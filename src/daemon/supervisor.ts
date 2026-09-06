import * as vscode from "vscode";

import { readConfiguration } from "../config.js";

import { initializeClient, ProtocolMismatchError } from "./client.js";
import { createDaemonConnection } from "./connection.js";
import { explain } from "./errors.js";
import { locateDaemon } from "./locate.js";
import { NotificationRouter, parseNotification } from "./notifications.js";
import { buildDaemonArgs, isDaemonMissingError, spawnDaemon } from "./process.js";
import type { SpawnedDaemon } from "./process.js";
import {
  DAEMON_EXECUTABLE_NAME,
  DAEMON_OUTPUT_CHANNEL_NAME,
  DaemonDisconnectedError,
} from "./types.js";
import type {
  DaemonConnection,
  DaemonExit,
  DaemonFault,
  DaemonLocation,
  DaemonNotification,
  DaemonStatus,
  DaemonSupervisor,
  Disposable,
  Event,
  MailcodedClient,
} from "./types.js";

const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const BACKOFF_CAP_MS = 30_000;
const JITTER = 0.2;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 120_000;

const SECONDARY_DETAIL =
  "Another mailcoded owns the mail store, so this daemon sends no change notifications. Refresh to see new mail.";

export interface MailcodedDaemonSupervisor extends DaemonSupervisor {
  readonly output: vscode.OutputChannel;
  readonly location: DaemonLocation | undefined;
  /** The awaitable half of `dispose`, so `deactivate` can wait for the shutdown handshake. */
  stop(): Promise<void>;
}

function jittered(base: number): number {
  return Math.max(250, Math.round(base * (1 + (Math.random() * 2 - 1) * JITTER)));
}

function describeExit(exit: DaemonExit): string {
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return exit.code === null ? "no exit code" : `exit code ${exit.code}`;
}

/** Structurally satisfied by `vscode.ExtensionContext`, so `activate` passes its context straight in. */
export interface DaemonSupervisorHost {
  readonly extensionPath: string;
  readonly extension?: { readonly packageJSON?: unknown } | undefined;
  readonly clientVersion?: string | undefined;
}

function clientVersionOf(host: DaemonSupervisorHost): string {
  if (typeof host.clientVersion === "string" && host.clientVersion !== "") return host.clientVersion;
  const manifest = host.extension?.packageJSON as { version?: unknown } | undefined;
  return typeof manifest?.version === "string" ? manifest.version : "0.0.0";
}

class Supervisor implements MailcodedDaemonSupervisor {
  readonly output: vscode.OutputChannel;

  readonly #statusEmitter = new vscode.EventEmitter<DaemonStatus>();
  readonly #router = new NotificationRouter();
  readonly #extensionPath: string;
  readonly #clientVersion: string;

  #status: DaemonStatus = { state: "stopped" };
  #session: Disposable[] = [];
  #process: SpawnedDaemon | undefined;
  #connection: DaemonConnection | undefined;
  #client: MailcodedClient | undefined;
  #location: DaemonLocation | undefined;

  #failures: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #starting: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;
  #stopping = false;
  #stopped = false;
  #permanent = false;

  constructor(host: DaemonSupervisorHost) {
    this.output = vscode.window.createOutputChannel(DAEMON_OUTPUT_CHANNEL_NAME);
    this.#extensionPath = host.extensionPath;
    this.#clientVersion = clientVersionOf(host);
  }

  get status(): DaemonStatus {
    return this.#status;
  }

  get onDidChangeStatus(): Event<DaemonStatus> {
    return this.#statusEmitter.event;
  }

  get onNotification(): Event<DaemonNotification> {
    return this.#router.onNotification;
  }

  get location(): DaemonLocation | undefined {
    return this.#location;
  }

  get client(): MailcodedClient {
    const client = this.#client;
    const state = this.#status.state;
    if (client === undefined || (state !== "ready" && state !== "secondary")) {
      throw new DaemonDisconnectedError(`The mailcoded daemon is not connected (state: ${state}).`);
    }
    return client;
  }

  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const pending = this.#starting;
    if (pending !== undefined) return pending;
    if (this.#client !== undefined) return Promise.resolve();

    const attempt = this.#launch().finally(() => {
      this.#starting = undefined;
    });
    this.#starting = attempt;
    return attempt;
  }

  async restart(): Promise<void> {
    if (this.#stopped) return;
    this.#clearRestartTimer();
    this.#failures = [];
    this.#permanent = false;
    const pending = this.#starting;
    if (pending !== undefined) await pending;
    await this.#stopSession(true);
    await this.start();
  }

  stop(): Promise<void> {
    this.#disposal ??= this.#teardown();
    return this.#disposal;
  }

  dispose(): void {
    void this.stop();
  }

  async #teardown(): Promise<void> {
    this.#stopped = true;
    this.#clearRestartTimer();

    const pending = this.#starting;
    if (pending !== undefined) await pending;

    await this.#stopSession(true);
    this.#setStatus({ state: "stopped" });

    this.#statusEmitter.dispose();
    this.#router.dispose();
    this.output.dispose();
  }

  async #launch(): Promise<void> {
    this.#clearRestartTimer();
    this.#setStatus({ state: "starting" });

    const config = readConfiguration();
    const location = locateDaemon({
      settingPath: config.daemonPath,
      isTrusted: vscode.workspace.isTrusted,
      extensionPath: this.#extensionPath,
    });

    if (location === undefined) {
      this.#permanent = true;
      this.#setStatus({
        state: "daemonMissing",
        detail:
          `Mailcoded could not find '${DAEMON_EXECUTABLE_NAME}'. Set 'mailcoded.daemonPath' to the ` +
          "executable, or put it on the PATH, then restart the daemon.",
      });
      return;
    }

    this.#location = location;
    this.#log(`locating: ${location.file} (source: ${location.source})`);

    const child = spawnDaemon(location, buildDaemonArgs({ dataDir: config.dataDir, logLevel: config.logLevel }), {
      output: this.output,
    });
    this.#process = child;
    this.#session.push(
      child.onSpawnError(() => {
        this.#connection?.dispose();
      }),
      child.onExit((exit) => {
        this.#onExit(exit);
      }),
    );

    const connection = createDaemonConnection({
      stdout: child.stdout,
      stdin: child.stdin,
      parseNotification,
    });
    this.#connection = connection;
    this.#session.push(
      connection.onNotification((notification) => {
        this.#router.dispatch(notification);
      }),
      connection.onFault((fault) => {
        this.#onFault(fault);
      }),
    );

    let client: MailcodedClient;
    try {
      client = await initializeClient(connection, this.#clientVersion);
    } catch (error: unknown) {
      await this.#onInitializeFailed(error, location);
      return;
    }

    this.#client = client;
    const capabilities = client.capabilities;
    this.#log(
      `initialized: daemon ${client.daemonVersion}, ${capabilities.methods.length} methods, ` +
        `watch ${String(capabilities.watch)}, send ${String(capabilities.send)}`,
    );

    this.#setStatus(
      capabilities.watch
        ? { state: "ready", capabilities, daemonVersion: client.daemonVersion }
        : { state: "secondary", capabilities, daemonVersion: client.daemonVersion, detail: SECONDARY_DETAIL },
    );
  }

  async #onInitializeFailed(error: unknown, location: DaemonLocation): Promise<void> {
    if (error instanceof ProtocolMismatchError) {
      this.#permanent = true;
      this.#log(
        `protocol mismatch: daemon speaks ${error.daemonProtocolVersion}, ` +
          `this extension speaks ${error.clientProtocolVersion}`,
      );
      await this.#stopSession(true);
      this.#setStatus({ state: "protocolMismatch", detail: error.message });
      return;
    }

    const spawnFailure = this.#process?.spawnError;
    if (spawnFailure !== undefined && isDaemonMissingError(spawnFailure)) {
      this.#permanent = true;
      this.#log(`spawn failed: ${location.file} does not exist or is not executable`);
      await this.#stopSession(false);
      this.#setStatus({
        state: "daemonMissing",
        detail: `Mailcoded could not run '${location.file}' (found via ${location.source}).`,
      });
      return;
    }

    const detail = explain(error, { operation: "Starting the mailcoded daemon" }).text;
    this.#log(`initialize failed: ${detail}`);

    // The exit or fault that broke initialize has usually already booked this incident; booking
    // it twice would spend the failure budget at half speed.
    const booked =
      this.#restartTimer !== undefined ||
      this.#status.state === "restarting" ||
      this.#status.state === "failed";
    this.#endSession();
    if (!booked) this.#scheduleRestart(detail);
  }

  /** A path that does not exist will not start existing, so this must never schedule a restart. */
  #reportMissingExecutable(): boolean {
    const failure = this.#process?.spawnError;
    const location = this.#location;
    if (failure === undefined || !isDaemonMissingError(failure) || location === undefined) return false;

    this.#permanent = true;
    this.#log(`spawn failed: ${location.file} does not exist or is not executable`);
    this.#endSession();
    this.#setStatus({
      state: "daemonMissing",
      detail: `Mailcoded could not run '${location.file}' (found via ${location.source}).`,
    });
    return true;
  }

  #onExit(exit: DaemonExit): void {
    if (this.#stopping || this.#stopped) return;
    if (this.#reportMissingExecutable()) return;
    const reason = `The mailcoded daemon exited (${describeExit(exit)}).`;
    this.#log(reason);
    this.#endSession();
    this.#scheduleRestart(reason);
  }

  #onFault(fault: DaemonFault): void {
    if (this.#stopping || this.#stopped) return;
    if (this.#reportMissingExecutable()) return;
    this.#log(`connection fault${fault.code === undefined ? "" : ` (code ${fault.code})`}: ${fault.reason}`);
    this.#endSession();
    this.#scheduleRestart(fault.reason);
  }

  #scheduleRestart(reason: string): void {
    if (this.#stopped || this.#permanent || this.#restartTimer !== undefined) return;

    const now = Date.now();
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    this.#failures.push(now);

    if (this.#failures.length >= MAX_FAILURES) {
      this.#permanent = true;
      this.#setStatus({
        state: "failed",
        detail: `${reason} It failed ${String(MAX_FAILURES)} times in two minutes, so Mailcoded stopped restarting it.`,
      });
      return;
    }

    const step = BACKOFF_MS[Math.min(this.#failures.length - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_CAP_MS;
    const delay = jittered(step);
    this.#setStatus({
      state: "restarting",
      detail: `${reason} Retrying in ${String(Math.round(delay / 1000))}s.`,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.start();
    }, delay);
  }

  async #stopSession(sendShutdown: boolean): Promise<void> {
    this.#stopping = true;
    this.#clearRestartTimer();
    try {
      const client = this.#client;
      if (sendShutdown && client !== undefined && this.#connection?.fault === undefined) {
        this.#log("shutdown");
        await client.shutdown().catch(() => undefined);
      }
    } finally {
      this.#endSession();
      this.#stopping = false;
    }
  }

  #endSession(): void {
    for (const subscription of this.#session) subscription.dispose();
    this.#session = [];

    const connection = this.#connection;
    const child = this.#process;
    this.#client = undefined;
    this.#connection = undefined;
    this.#process = undefined;

    connection?.dispose();
    child?.dispose();
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #setStatus(status: DaemonStatus): void {
    this.#status = status;
    this.#log(`state: ${status.state}${status.detail === undefined ? "" : ` — ${status.detail}`}`);
    this.#statusEmitter.fire(status);
  }

  /** Extension-side lifecycle only. Wire payloads never reach this channel. */
  #log(message: string): void {
    this.output.appendLine(`[mailcoded] ${message}`);
  }
}

export function createDaemonSupervisor(host: DaemonSupervisorHost): MailcodedDaemonSupervisor {
  return new Supervisor(host);
}
