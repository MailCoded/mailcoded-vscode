export interface FakeDisposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): FakeDisposable => {
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable implements FakeDisposable {
  static from(...items: readonly FakeDisposable[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }

  constructor(private readonly callOnDispose: () => void) {}

  dispose(): void {
    this.callOnDispose();
  }
}

export interface FakeOutputChannel extends FakeDisposable {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  trace(value: string): void;
  debug(value: string): void;
  info(value: string): void;
  warn(value: string): void;
  error(value: string): void;
}

interface FakeVscodeState {
  readonly channels: Map<string, string[]>;
  readonly notifications: string[];
  readonly configuration: Map<string, unknown>;
  readonly contentProviders: Map<string, FakeContentProvider>;
  readonly shownDocuments: FakeTextDocument[];
  readonly inputBoxAnswers: (string | undefined)[];
  readonly messageAnswers: (string | undefined)[];
  readonly progress: string[];
  readonly quickPickAnswers: (string | undefined)[];
  readonly quickPicks: string[][];
  readonly commandHandlers: Map<string, (...args: readonly unknown[]) => unknown>;
  readonly webviewPanels: FakeWebviewPanel[];
  webviewCspSource: string;
}

/** Exactly what a Remote-WSL extension host returns: `cspSource` is a source list, and
 * `asWebviewUri` maps a file: URI onto `<scheme>+<encoded authority>.vscode-resource.vscode-cdn.net`,
 * whose `+` the URI serializer then percent-encodes and whose case it lowers. */
export const REAL_WEBVIEW_CSP_SOURCE = "'self' https://*.vscode-cdn.net";
export const REAL_WEBVIEW_RESOURCE_AUTHORITY = "vscode-remote%2Bwsl-002bubuntu.vscode-resource.vscode-cdn.net";

/** The alias resolves for both `import` and `require`, so the module can load twice; the state
 * it records must not. */
const state: FakeVscodeState = ((): FakeVscodeState => {
  const host = globalThis as unknown as { __mailcodedFakeVscode?: FakeVscodeState };
  host.__mailcodedFakeVscode ??= {
    channels: new Map<string, string[]>(),
    notifications: [],
    configuration: new Map<string, unknown>(),
    contentProviders: new Map<string, FakeContentProvider>(),
    shownDocuments: [],
    inputBoxAnswers: [],
    messageAnswers: [],
    progress: [],
    quickPickAnswers: [],
    quickPicks: [],
    commandHandlers: new Map<string, (...args: readonly unknown[]) => unknown>(),
    webviewPanels: [],
    webviewCspSource: REAL_WEBVIEW_CSP_SOURCE,
  };
  return host.__mailcodedFakeVscode;
})();

class Recorder {
  readonly channels = state.channels;
  readonly notifications = state.notifications;
  readonly shownDocuments = state.shownDocuments;
  readonly webviewPanels = state.webviewPanels;
  /** Titles passed to `window.withProgress`, so "the user was told it is working" is testable. */
  readonly progress = state.progress;
  /** The labels offered by each `window.showQuickPick` call, in order. */
  readonly quickPicks = state.quickPicks;

  reset(): void {
    this.channels.clear();
    this.notifications.length = 0;
    this.shownDocuments.length = 0;
    state.inputBoxAnswers.length = 0;
    state.messageAnswers.length = 0;
    this.progress.length = 0;
    state.quickPickAnswers.length = 0;
    this.quickPicks.length = 0;
    state.commandHandlers.clear();
    this.webviewPanels.length = 0;
    state.webviewCspSource = REAL_WEBVIEW_CSP_SOURCE;
  }

  /** What `webview.cspSource` answers from here on; `reset()` restores the real value. */
  setWebviewCspSource(value: string): void {
    state.webviewCspSource = value;
  }

  /** What `window.showInputBox` answers, in order; an exhausted queue answers `undefined`. */
  answerInputBox(...answers: readonly (string | undefined)[]): void {
    state.inputBoxAnswers.push(...answers);
  }

  /** Which label `window.showQuickPick` picks, in order; an exhausted queue dismisses the pick. */
  answerQuickPick(...answers: readonly (string | undefined)[]): void {
    state.quickPickAnswers.push(...answers);
  }

  /** Which button a notification is answered with, in order. An answer the call did not offer is
   * ignored, exactly as a dismissed notification behaves. */
  answerMessage(...answers: readonly (string | undefined)[]): void {
    state.messageAnswers.push(...answers);
  }

  lines(name?: string): readonly string[] {
    if (name !== undefined) return this.channels.get(name) ?? [];
    return [...this.channels.values()].flat();
  }

  everything(): string {
    return [...this.lines(), ...this.notifications].join("\n");
  }

  record(name: string, value: string): void {
    const existing = this.channels.get(name);
    if (existing === undefined) this.channels.set(name, [value]);
    else existing.push(value);
  }
}

export const recorder = new Recorder();

class FakeConfiguration {
  constructor(private readonly section: string | undefined) {}

  get<T>(key: string, defaultValue?: T): T | undefined {
    const full = this.section === undefined ? key : `${this.section}.${key}`;
    if (configuration.has(full)) return configuration.get(full) as T;
    return defaultValue;
  }

  has(key: string): boolean {
    return configuration.has(this.section === undefined ? key : `${this.section}.${key}`);
  }

  inspect(): undefined {
    return undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    configuration.set(this.section === undefined ? key : `${this.section}.${key}`, value);
    return Promise.resolve();
  }
}

export const configuration = state.configuration;

const configurationChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
const trustGranted = new EventEmitter<void>();

function createOutputChannel(name: string): FakeOutputChannel {
  const push = (value: string): void => recorder.record(name, value);
  return {
    name,
    append: push,
    appendLine: push,
    replace: push,
    trace: push,
    debug: push,
    info: push,
    warn: push,
    error: push,
    clear: () => recorder.channels.set(name, []),
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

function showMessage(message: string, ...items: readonly string[]): Promise<string | undefined> {
  recorder.notifications.push(message);
  const answer = state.messageAnswers.shift();
  return Promise.resolve(answer !== undefined && items.includes(answer) ? answer : undefined);
}

export interface FakeUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;
  toString(): string;
}

export interface FakeTextDocument {
  readonly uri: FakeUri;
  languageId: string;
  getText(): string;
}

export interface FakeContentProvider {
  provideTextDocumentContent(uri: FakeUri): string | Promise<string> | undefined | null;
}

const URI = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

function parseUri(value: string, strict = false): FakeUri {
  const parts = URI.exec(value);
  const scheme = parts?.[1] ?? "";
  if (strict && scheme === "") throw new Error(`'${value}' names no scheme`);
  const path = decodeURIComponent(parts?.[3] ?? "");
  return {
    scheme,
    authority: parts?.[2] ?? "",
    path,
    query: parts?.[4] ?? "",
    fragment: parts?.[5] ?? "",
    fsPath: path,
    toString: () => value,
  };
}

/** A content provider's document is read-only and re-read on demand, exactly as in the host. */
async function openTextDocument(uri: FakeUri): Promise<FakeTextDocument> {
  const provider = state.contentProviders.get(uri.scheme);
  if (provider === undefined) throw new Error(`No content provider is registered for '${uri.scheme}'`);
  const text = (await provider.provideTextDocumentContent(uri)) ?? "";
  return { uri, languageId: "plaintext", getText: () => text };
}

export interface FakeTreeView<T> extends FakeDisposable {
  selection: readonly T[];
  visible: boolean;
  description: string | undefined;
  title?: string;
  badge: { value: number; tooltip: string } | undefined;
  message?: string;
  reveal(element: T): Promise<void>;
  onDidChangeSelection: (listener: (event: { selection: readonly T[] }) => void) => FakeDisposable;
  onDidChangeVisibility: (listener: (event: { visible: boolean }) => void) => FakeDisposable;
}

function createTreeView<T>(): FakeTreeView<T> {
  const selectionChanged = new EventEmitter<{ selection: readonly T[] }>();
  const visibilityChanged = new EventEmitter<{ visible: boolean }>();
  return {
    selection: [],
    visible: true,
    description: undefined,
    badge: undefined,
    reveal: () => Promise.resolve(),
    onDidChangeSelection: selectionChanged.event,
    onDidChangeVisibility: visibilityChanged.event,
    dispose: () => {
      selectionChanged.dispose();
      visibilityChanged.dispose();
    },
  };
}

export interface FakeWebviewPanel extends FakeDisposable {
  readonly viewType: string;
  title: string;
  readonly viewColumn: number;
  readonly visible: boolean;
  readonly active: boolean;
  readonly options: unknown;
  readonly webview: {
    html: string;
    readonly cspSource: string;
    readonly options: unknown;
    asWebviewUri(uri: FakeUri): FakeUri;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => void): FakeDisposable;
  };
  readonly posted: unknown[];
  readonly disposed: boolean;
  /** Simulates a message from the webview's script, as `acquireVsCodeApi().postMessage` would send. */
  receive(message: unknown): void;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): FakeDisposable;
  onDidChangeViewState(listener: (event: { webviewPanel: FakeWebviewPanel }) => void): FakeDisposable;
}

function createWebviewPanel(viewType: string, title: string, viewColumn: number, options: unknown): FakeWebviewPanel {
  const received = new EventEmitter<unknown>();
  const disposedEvent = new EventEmitter<void>();
  const viewState = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
  const posted: unknown[] = [];
  let disposed = false;
  const panel: FakeWebviewPanel = {
    viewType,
    title,
    viewColumn,
    visible: true,
    active: true,
    options,
    webview: {
      html: "",
      get cspSource(): string {
        return state.webviewCspSource;
      },
      options,
      asWebviewUri: (uri: FakeUri): FakeUri => parseUri(`https://${REAL_WEBVIEW_RESOURCE_AUTHORITY}${uri.path}`),
      postMessage: (message: unknown): Promise<boolean> => {
        if (disposed) throw new Error("Webview is disposed");
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: received.event,
    },
    posted,
    get disposed(): boolean {
      return disposed;
    },
    receive: (message: unknown): void => {
      received.fire(message);
    },
    reveal: (): void => undefined,
    onDidDispose: (listener: () => void): FakeDisposable => disposedEvent.event(listener),
    onDidChangeViewState: viewState.event,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      disposedEvent.fire();
      received.dispose();
      viewState.dispose();
    },
  };
  state.webviewPanels.push(panel);
  return panel;
}

export const window = {
  createOutputChannel,
  createTreeView,
  createWebviewPanel,
  showInputBox: (): Promise<string | undefined> =>
    Promise.resolve(state.inputBoxAnswers.length === 0 ? undefined : state.inputBoxAnswers.shift()),
  showTextDocument: (document: FakeTextDocument): Promise<{ document: FakeTextDocument }> => {
    state.shownDocuments.push(document);
    return Promise.resolve({ document });
  },
  showInformationMessage: showMessage,
  showWarningMessage: showMessage,
  showErrorMessage: showMessage,
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  withProgress: <T>(options: unknown, task: () => PromiseLike<T>): PromiseLike<T> => {
    const title = (options as { title?: unknown } | undefined)?.title;
    if (typeof title === "string") state.progress.push(title);
    return task();
  },
  showSaveDialog: (): Promise<FakeUri | undefined> => Promise.resolve(undefined),
  showQuickPick: <T extends { label: string }>(items: readonly T[]): Promise<T | undefined> => {
    state.quickPicks.push(items.map((item) => item.label));
    const wanted = state.quickPickAnswers.shift();
    return Promise.resolve(wanted === undefined ? undefined : items.find((item) => item.label === wanted));
  },
};

export const workspace = {
  isTrusted: true,
  workspaceFolders: undefined,
  openTextDocument,
  registerTextDocumentContentProvider: (scheme: string, provider: FakeContentProvider): FakeDisposable => {
    state.contentProviders.set(scheme, provider);
    return {
      dispose: () => {
        state.contentProviders.delete(scheme);
      },
    };
  },
  getConfiguration: (section?: string): FakeConfiguration => new FakeConfiguration(section),
  onDidChangeConfiguration: configurationChanged.event,
  onDidGrantWorkspaceTrust: trustGranted.event,
};

/** Handlers are kept, so a test can invoke a contributed command the way the palette does. An
 * unregistered command resolves to undefined, as it did before. */
export const commands = {
  executeCommand: async (command: string, ...args: readonly unknown[]): Promise<unknown> => {
    const handler = state.commandHandlers.get(command);
    return handler === undefined ? undefined : await handler(...args);
  },
  registerCommand: (command: string, handler: (...args: readonly unknown[]) => unknown): FakeDisposable => {
    state.commandHandlers.set(command, handler);
    return {
      dispose: () => {
        state.commandHandlers.delete(command);
      },
    };
  },
};

export const env = {
  openExternal: (): Promise<boolean> => Promise.resolve(true),
  appName: "Mocha",
  language: "en",
};

export const Uri = {
  parse: parseUri,
  file: (fsPath: string): FakeUri => parseUri(`file://${fsPath}`),
  joinPath: (base: { fsPath: string }, ...parts: readonly string[]) => Uri.file([base.fsPath, ...parts].join("/")),
};

export const languages = {
  setTextDocumentLanguage: (document: FakeTextDocument, languageId: string): Promise<FakeTextDocument> => {
    document.languageId = languageId;
    return Promise.resolve(document);
  },
};

export const l10n = {
  t: (message: string, ...args: readonly unknown[]): string =>
    message.replace(/\{(\d+)\}/g, (whole, index: string) => {
      const value = args[Number(index)];
      if (value === undefined) return whole;
      switch (typeof value) {
        case "string":
          return value;
        case "number":
        case "boolean":
        case "bigint":
          return value.toString();
        default:
          return JSON.stringify(value) ?? whole;
      }
    }),
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const;
export const version = "1.96.0";

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class TreeItem {
  label: string | { label: string; highlights?: readonly [number, number][] };
  collapsibleState: number;
  id?: string;
  description?: string | boolean;
  tooltip?: string;
  contextValue?: string;
  iconPath?: ThemeIcon;
  command?: { command: string; title: string; arguments?: readonly unknown[] };
  resourceUri?: unknown;
  accessibilityInformation?: { label: string };

  constructor(
    label: string | { label: string; highlights?: readonly [number, number][] },
    collapsibleState: number = TreeItemCollapsibleState.None,
  ) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
