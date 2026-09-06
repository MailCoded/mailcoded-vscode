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
}

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
  };
  return host.__mailcodedFakeVscode;
})();

class Recorder {
  readonly channels = state.channels;
  readonly notifications = state.notifications;
  readonly shownDocuments = state.shownDocuments;

  reset(): void {
    this.channels.clear();
    this.notifications.length = 0;
    this.shownDocuments.length = 0;
    state.inputBoxAnswers.length = 0;
  }

  /** What `window.showInputBox` answers, in order; an exhausted queue answers `undefined`. */
  answerInputBox(...answers: readonly (string | undefined)[]): void {
    state.inputBoxAnswers.push(...answers);
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

function showMessage(message: string): Promise<undefined> {
  recorder.notifications.push(message);
  return Promise.resolve(undefined);
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

export const window = {
  createOutputChannel,
  createTreeView,
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
  withProgress: <T>(_options: unknown, task: () => PromiseLike<T>): PromiseLike<T> => task(),
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

export const commands = {
  executeCommand: (): Promise<undefined> => Promise.resolve(undefined),
  registerCommand: (): FakeDisposable => ({ dispose: () => undefined }),
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
