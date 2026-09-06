import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DaemonStatus, DaemonSupervisor, MailcodedClient, UserFacingError } from "../../src/daemon/types.js";
import { RpcError } from "../../src/daemon/types.js";
import { configuration, recorder, window } from "../mock-daemon/fakeVscode.js";

const DAEMON_SRC = new URL("../../src/daemon/", import.meta.url);
const MOCK_SCRIPT = fileURLToPath(new URL("../mock-daemon/mockDaemon.mjs", import.meta.url));

const IS_WINDOWS = process.platform === "win32";

/** Resolved at run time, not statically imported: the harness must compile before the
 * implementations land, and must name a missing export instead of failing to load. */
async function loadDaemonModule(name: string): Promise<Record<string, unknown>> {
  const url = new URL(`${name}.ts`, DAEMON_SRC).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`src/daemon/${name}.ts could not be loaded: ${describeUnknown(cause)}`, { cause });
  }
}

function pickExport(module: Record<string, unknown>, names: readonly string[], hint: string): unknown {
  for (const name of names) {
    const candidate = module[name];
    if (candidate !== undefined) return candidate;
  }
  throw new Error(
    `${hint}: expected one of [${names.join(", ")}]; the module exports [${Object.keys(module).join(", ")}]`,
  );
}

function invoke<T>(factory: unknown, args: readonly unknown[]): T {
  if (typeof factory !== "function") throw new Error("the resolved export is not callable");
  if (/^\s*class\s/.test(Function.prototype.toString.call(factory))) {
    const constructable = factory as new (...rest: readonly unknown[]) => T;
    return new constructable(...args);
  }
  return (factory as (...rest: readonly unknown[]) => T)(...args);
}

export interface JournalEntry {
  readonly at: number;
  readonly pid: number;
  readonly event: string;
  readonly method?: string;
  readonly scenario?: string;
  readonly code?: number;
}

export interface MockDaemon {
  readonly file: string;
  readonly journalPath: string;
  entries(): readonly JournalEntry[];
  methods(): readonly string[];
  pids(): readonly number[];
}

const tempDirectories: string[] = [];

process.on("exit", () => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
});

/** A shim rather than `MAILCODED_DAEMON=node`: the supervisor owns the argv it spawns with, so
 * the scenario and the journal must travel inside the executable, not beside it. */
export function mockDaemon(scenario: string): MockDaemon {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mailcoded-mock-"));
  tempDirectories.push(directory);
  const journalPath = path.join(directory, "journal.jsonl");
  const file = path.join(directory, IS_WINDOWS ? "mailcoded-daemon.cmd" : "mailcoded-daemon");
  const body = IS_WINDOWS
    ? `@echo off\r\n"${process.execPath}" "${MOCK_SCRIPT}" --scenario ${scenario} --journal "${journalPath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${MOCK_SCRIPT}" --scenario ${scenario} --journal "${journalPath}" "$@"\n`;
  writeFileSync(file, body);
  if (!IS_WINDOWS) chmodSync(file, 0o755);
  writeFileSync(journalPath, "");

  const entries = (): readonly JournalEntry[] => {
    let raw: string;
    try {
      raw = readFileSync(journalPath, "utf8");
    } catch {
      return [];
    }
    const parsed: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        parsed.push(JSON.parse(line) as JournalEntry);
      } catch {
        break;
      }
    }
    return parsed;
  };

  return {
    file,
    journalPath,
    entries,
    methods: () => entries().flatMap((entry) => (entry.method === undefined ? [] : [entry.method])),
    pids: () => [...new Set(entries().map((entry) => entry.pid))],
  };
}

export interface TestLogger {
  readonly records: string[];
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  appendLine(message: string): void;
  append(message: string): void;
  log(message: string): void;
}

export function testLogger(): TestLogger {
  const records: string[] = [];
  const push = (message: string): void => {
    records.push(message);
  };
  return {
    records,
    trace: push,
    debug: push,
    info: push,
    warn: push,
    error: push,
    appendLine: push,
    append: push,
    log: push,
  };
}

export interface StartedSupervisor {
  readonly supervisor: DaemonSupervisor;
  readonly daemon: MockDaemon;
  readonly statuses: DaemonStatus[];
  readonly logger: TestLogger;
  client(): MailcodedClient;
  clientOrUndefined(): MailcodedClient | undefined;
}

const started: DaemonSupervisor[] = [];
let savedDaemonEnv: string | undefined;
let savedDaemonEnvPresent = false;

function setDaemonEnv(file: string): void {
  if (!savedDaemonEnvPresent) {
    savedDaemonEnv = process.env["MAILCODED_DAEMON"];
    savedDaemonEnvPresent = true;
  }
  process.env["MAILCODED_DAEMON"] = file;
}

/** Deliberately a superset: `types.ts` does not fix the supervisor's option names, and a bag
 * shaped like an ExtensionContext too fits either constructor signature. */
function supervisorOptions(daemonFile: string, logger: TestLogger): Record<string, unknown> {
  const storeDirectory = mkdtempSync(path.join(os.tmpdir(), "mailcoded-store-"));
  tempDirectories.push(storeDirectory);
  const storePath = path.join(storeDirectory, "store.db");
  return {
    clientVersion: "0.1.0-test",
    daemonPath: daemonFile,
    storePath,
    store: storePath,
    dataDir: storeDirectory,
    globalStoragePath: storeDirectory,
    globalStorageUri: { fsPath: storeDirectory, scheme: "file", path: storeDirectory },
    extensionPath: storeDirectory,
    extensionUri: { fsPath: storeDirectory, scheme: "file", path: storeDirectory },
    storageUri: undefined,
    subscriptions: [] as unknown[],
    asAbsolutePath: (relative: string) => path.join(storeDirectory, relative),
    logger,
    output: logger,
    outputChannel: logger,
  };
}

export interface StartOptions {
  readonly waitFor?: readonly DaemonStatus["state"][];
  readonly daemonFile?: string;
  readonly timeoutMs?: number;
}

export async function startSupervisor(scenario: string, options: StartOptions = {}): Promise<StartedSupervisor> {
  const daemon = mockDaemon(scenario);
  const daemonFile = options.daemonFile ?? daemon.file;
  setDaemonEnv(daemonFile);
  configuration.set("mailcoded.daemonPath", daemonFile);

  const logger = testLogger();
  const module = await loadDaemonModule("supervisor");
  const factory = pickExport(
    module,
    [
      "createDaemonSupervisor",
      "createSupervisor",
      "DaemonSupervisorImpl",
      "VscodeDaemonSupervisor",
      "NodeDaemonSupervisor",
      "DaemonSupervisorHost",
      "Supervisor",
      "default",
    ],
    "src/daemon/supervisor.ts",
  );
  const supervisor = invoke<DaemonSupervisor>(factory, [supervisorOptions(daemonFile, logger)]);
  started.push(supervisor);

  const statuses: DaemonStatus[] = [];
  supervisor.onDidChangeStatus((status) => statuses.push(status));

  await supervisor.start().catch(() => undefined);
  const wanted = options.waitFor;
  if (wanted !== undefined) {
    await waitFor(
      () => wanted.includes(supervisor.status.state),
      `the supervisor to reach one of [${wanted.join(", ")}] (last was '${supervisor.status.state}')`,
      options.timeoutMs ?? 8000,
    );
  }

  return {
    supervisor,
    daemon,
    statuses,
    logger,
    client: () => supervisor.client,
    clientOrUndefined: () => {
      try {
        return supervisor.client;
      } catch {
        return undefined;
      }
    },
  };
}

export async function teardown(): Promise<void> {
  for (const supervisor of started.splice(0)) {
    try {
      supervisor.dispose();
    } catch {
      // a disposed-twice supervisor must not fail the next test
    }
  }
  await delay(50);
  recorder.reset();
  configuration.clear();
  if (savedDaemonEnvPresent) {
    if (savedDaemonEnv === undefined) delete process.env["MAILCODED_DAEMON"];
    else process.env["MAILCODED_DAEMON"] = savedDaemonEnv;
    savedDaemonEnvPresent = false;
    savedDaemonEnv = undefined;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await delay(intervalMs);
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function rejects(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

export function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  throw new Error(`expected an RpcError, got ${describeUnknown(error)}`);
}

export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "undefined";
}

export async function explain(error: RpcError): Promise<UserFacingError> {
  const module = await loadDaemonModule("errors");
  const explainer = pickExport(
    module,
    ["explain", "explainError", "toUserFacingError", "describe", "userFacingError"],
    "src/daemon/errors.ts",
  );
  return invoke<UserFacingError>(explainer, [error]);
}

/** Everything the extension could plausibly have written, in one string for the secrecy test. */
export function capturedOutput(logger: TestLogger, extra: readonly string[] = []): string {
  return [recorder.everything(), ...logger.records, ...extra].join("\n");
}

export interface ConsoleCapture {
  readonly records: string[];
  restore(): void;
}

export function captureConsole(): ConsoleCapture {
  const records: string[] = [];
  const names = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;
  const surface = console as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of names) {
    saved.set(name, surface[name]);
    surface[name] = (...args: readonly unknown[]): void => {
      records.push(args.map((value) => String(value)).join(" "));
    };
  }
  return {
    records,
    restore: () => {
      for (const [name, original] of saved) surface[name] = original;
    },
  };
}

describe("harness", () => {
  it("builds a spawnable mock daemon shim and an empty journal", () => {
    const daemon = mockDaemon("happy");
    assert.equal(daemon.methods().length, 0);
    assert.ok(daemon.file.length > 0);
  });

  it("records everything written to a fake output channel", () => {
    const channel = window.createOutputChannel("Mailcoded Daemon");
    channel.appendLine("imap connected");
    assert.ok(recorder.everything().includes("imap connected"));
    recorder.reset();
  });
});
