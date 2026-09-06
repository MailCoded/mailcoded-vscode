import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import type { DaemonExit, DaemonLocation, DaemonProcess, Disposable, Event } from "./types.js";

/** Structurally `vscode.OutputChannel`, so the supervisor can pass its channel straight in. */
export interface DaemonOutputSink {
  appendLine(value: string): void;
}

export interface SpawnDaemonOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  /** Receives daemon stderr only, one line at a time. Nothing we send may ever reach it. */
  readonly output?: DaemonOutputSink | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
}

export interface SpawnedDaemon extends DaemonProcess {
  readonly spawnError: NodeJS.ErrnoException | undefined;
  readonly onSpawnError: Event<NodeJS.ErrnoException>;
}

export interface DaemonArgsOptions {
  readonly dataDir?: string | undefined;
  readonly logLevel?: string | undefined;
}

export const DAEMON_STORE_FILE_NAME = "store.db";

export const DAEMON_LOG_LEVELS: readonly string[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_KILL_TIMEOUT_MS = 2_000;
const MAX_PENDING_STDERR_CHARS = 64 * 1024;

/** An unrecognized flag makes the daemon exit before it ever frames a response, so an
 * out-of-range log level is dropped rather than passed through. */
export function buildDaemonArgs(options: DaemonArgsOptions = {}): string[] {
  const args: string[] = [];

  const dataDir = options.dataDir?.trim();
  if (dataDir !== undefined && dataDir !== "") {
    args.push("--store", path.join(dataDir, DAEMON_STORE_FILE_NAME));
  }

  const logLevel = options.logLevel?.trim().toLowerCase();
  if (logLevel !== undefined && DAEMON_LOG_LEVELS.includes(logLevel)) {
    args.push("--log-level", logLevel);
  }

  return args;
}

/** ENOENT is an absent executable, which is `daemonMissing` and not a generic failure. */
export function isDaemonMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function spawnDaemon(
  location: DaemonLocation,
  args: readonly string[] = [],
  options: SpawnDaemonOptions = {},
): SpawnedDaemon {
  const daemon = new SpawnedDaemonProcess(location, args, options);
  const sink = options.output;
  if (sink !== undefined) {
    daemon.onStderrLine((line) => {
      sink.appendLine(line);
    });
  }
  daemon.launch();
  return daemon;
}

class Emitter<T> implements Disposable {
  #listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener: (e: T) => void): Disposable => {
    this.#listeners.add(listener);
    return {
      dispose: (): void => {
        this.#listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

class SpawnedDaemonProcess implements SpawnedDaemon {
  readonly location: DaemonLocation;

  readonly #args: readonly string[];
  readonly #options: SpawnDaemonOptions;
  readonly #stderr = new Emitter<string>();
  readonly #exit = new Emitter<DaemonExit>();
  readonly #spawnFailed = new Emitter<NodeJS.ErrnoException>();

  #child: ChildProcess | undefined;
  #stdin: Writable = new PassThrough();
  #stdout: Readable = new PassThrough();
  #pending = "";
  #exited = false;
  #disposed = false;
  #spawnError: NodeJS.ErrnoException | undefined;
  #graceTimer: NodeJS.Timeout | undefined;
  #forceTimer: NodeJS.Timeout | undefined;

  constructor(location: DaemonLocation, args: readonly string[], options: SpawnDaemonOptions) {
    this.location = location;
    this.#args = args;
    this.#options = options;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get stdin(): Writable {
    return this.#stdin;
  }

  get stdout(): Readable {
    return this.#stdout;
  }

  get spawnError(): NodeJS.ErrnoException | undefined {
    return this.#spawnError;
  }

  get onStderrLine(): Event<string> {
    return this.#stderr.event;
  }

  get onExit(): Event<DaemonExit> {
    return this.#exit.event;
  }

  get onSpawnError(): Event<NodeJS.ErrnoException> {
    return this.#spawnFailed.event;
  }

  launch(): void {
    const spawnOptions: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    if (this.#options.env !== undefined) spawnOptions.env = this.#options.env;
    if (this.#options.cwd !== undefined) spawnOptions.cwd = this.#options.cwd;

    let child: ChildProcess;
    try {
      child = spawn(this.location.file, this.#args, spawnOptions);
    } catch (error: unknown) {
      const failure = error as NodeJS.ErrnoException;
      this.#spawnError = failure;
      setImmediate(() => {
        this.#spawnFailed.fire(failure);
        this.#settleExit({ code: null, signal: null });
      });
      return;
    }

    this.#child = child;
    if (child.stdin !== null) this.#stdin = child.stdin;
    if (child.stdout !== null) this.#stdout = child.stdout;

    // A write to a daemon that has already died is an unhandled 'error' that takes down the host.
    child.stdin?.on("error", ignore);
    child.stdout?.on("error", ignore);

    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        this.#consumeStderr(chunk);
      });
      stderr.on("error", ignore);
      stderr.on("end", () => {
        this.#flushStderr();
      });
    }

    child.on("error", (error) => {
      const failure = error as NodeJS.ErrnoException;
      this.#spawnError ??= failure;
      this.#spawnFailed.fire(failure);
      this.#settleExit({ code: null, signal: null });
    });

    child.on("exit", (code, signal) => {
      this.#settleExit({ code, signal });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    const child = this.#child;
    if (child === undefined || this.#exited) {
      this.#clearTimers();
      return;
    }

    child.stdin?.end();

    const grace = this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#graceTimer = later(grace, () => {
      if (this.#exited) return;
      child.kill("SIGTERM");
      this.#forceTimer = later(FORCE_KILL_TIMEOUT_MS, () => {
        if (this.#exited) return;
        forceKill(child);
      });
    });
  }

  #settleExit(exit: DaemonExit): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#clearTimers();
    this.#flushStderr();
    this.#exit.fire(exit);
  }

  #consumeStderr(chunk: string): void {
    this.#pending += chunk;
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      this.#emitLine(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > MAX_PENDING_STDERR_CHARS) this.#flushStderr();
  }

  #flushStderr(): void {
    if (this.#pending === "") return;
    const line = this.#pending;
    this.#pending = "";
    this.#emitLine(line);
  }

  #emitLine(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text !== "") this.#stderr.fire(text);
  }

  #clearTimers(): void {
    if (this.#graceTimer !== undefined) clearTimeout(this.#graceTimer);
    if (this.#forceTimer !== undefined) clearTimeout(this.#forceTimer);
    this.#graceTimer = undefined;
    this.#forceTimer = undefined;
  }
}

function later(ms: number, run: () => void): NodeJS.Timeout {
  const timer = setTimeout(run, ms);
  timer.unref();
  return timer;
}

function forceKill(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform !== "win32" || pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", () => {
    child.kill("SIGKILL");
  });
}

function ignore(): void {
  return;
}
