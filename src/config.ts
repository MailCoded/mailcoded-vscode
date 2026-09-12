import * as vscode from "vscode";

export const CONFIG_SECTION = "mailcoded";

export const LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const SEARCH_MODES = ["auto", "words"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

export interface MailcodedConfig {
  /** Restricted: empty in an untrusted workspace, whatever the settings say. */
  readonly daemonPath: string;
  /** Restricted: empty in an untrusted workspace, whatever the settings say. */
  readonly dataDir: string;
  readonly pageSize: number;
  readonly markReadOnOpen: boolean;
  readonly notifyNewMail: boolean;
  readonly logLevel: LogLevel;
  readonly quoteLines: number;
  readonly threadGrouping: boolean;
  readonly pollIntervalSeconds: number;
  readonly searchMode: SearchMode;
}

export const CONFIG_DEFAULTS: MailcodedConfig = {
  daemonPath: "",
  dataDir: "",
  pageSize: 50,
  markReadOnOpen: true,
  notifyNewMail: true,
  logLevel: "info",
  quoteLines: 200,
  threadGrouping: true,
  pollIntervalSeconds: 60,
  searchMode: "auto",
};

export const PAGE_SIZE_MIN = 10;
export const PAGE_SIZE_MAX = 200;
const POLL_INTERVAL_MIN_SECONDS = 15;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function searchMode(value: unknown): SearchMode {
  return typeof value === "string" && (SEARCH_MODES as readonly string[]).includes(value)
    ? (value as SearchMode)
    : CONFIG_DEFAULTS.searchMode;
}

function logLevel(value: unknown): LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : CONFIG_DEFAULTS.logLevel;
}

/** Re-checking trust here means one host-side bug is not enough to redirect which binary we spawn. */
export function readConfiguration(scope?: vscode.ConfigurationScope): MailcodedConfig {
  const section =
    scope === undefined
      ? vscode.workspace.getConfiguration(CONFIG_SECTION)
      : vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  const trusted = vscode.workspace.isTrusted;
  return {
    daemonPath: trusted ? text(section.get("daemonPath")) : CONFIG_DEFAULTS.daemonPath,
    dataDir: trusted ? text(section.get("dataDir")) : CONFIG_DEFAULTS.dataDir,
    pageSize: clampInteger(section.get("pageSize"), CONFIG_DEFAULTS.pageSize, PAGE_SIZE_MIN, PAGE_SIZE_MAX),
    markReadOnOpen: boolean(section.get("markReadOnOpen"), CONFIG_DEFAULTS.markReadOnOpen),
    notifyNewMail: boolean(section.get("notifyNewMail"), CONFIG_DEFAULTS.notifyNewMail),
    logLevel: logLevel(section.get("logLevel")),
    quoteLines: clampInteger(section.get("quoteLines"), CONFIG_DEFAULTS.quoteLines, 0, Number.MAX_SAFE_INTEGER),
    threadGrouping: boolean(section.get("threadGrouping"), CONFIG_DEFAULTS.threadGrouping),
    searchMode: searchMode(section.get("searchMode")),
    pollIntervalSeconds: clampInteger(
      section.get("pollIntervalSeconds"),
      CONFIG_DEFAULTS.pollIntervalSeconds,
      POLL_INTERVAL_MIN_SECONDS,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function same(a: MailcodedConfig, b: MailcodedConfig): boolean {
  return (
    a.daemonPath === b.daemonPath &&
    a.dataDir === b.dataDir &&
    a.pageSize === b.pageSize &&
    a.markReadOnOpen === b.markReadOnOpen &&
    a.notifyNewMail === b.notifyNewMail &&
    a.logLevel === b.logLevel &&
    a.quoteLines === b.quoteLines &&
    a.threadGrouping === b.threadGrouping &&
    a.pollIntervalSeconds === b.pollIntervalSeconds
  );
}

export class MailcodedConfiguration implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<MailcodedConfig>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private value: MailcodedConfig;

  readonly onDidChange: vscode.Event<MailcodedConfig> = this.emitter.event;

  constructor() {
    this.value = readConfiguration();
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.refresh();
      }),
    );
  }

  get current(): MailcodedConfig {
    return this.value;
  }

  refresh(): MailcodedConfig {
    const next = readConfiguration();
    if (same(this.value, next)) {
      return this.value;
    }
    this.value = next;
    this.emitter.fire(next);
    return next;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.emitter.dispose();
  }
}
