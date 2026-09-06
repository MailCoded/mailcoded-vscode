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
}

/** The alias resolves for both `import` and `require`, so the module can load twice; the state
 * it records must not. */
const state: FakeVscodeState = ((): FakeVscodeState => {
  const host = globalThis as unknown as { __mailcodedFakeVscode?: FakeVscodeState };
  host.__mailcodedFakeVscode ??= {
    channels: new Map<string, string[]>(),
    notifications: [],
    configuration: new Map<string, unknown>(),
  };
  return host.__mailcodedFakeVscode;
})();

class Recorder {
  readonly channels = state.channels;
  readonly notifications = state.notifications;

  reset(): void {
    this.channels.clear();
    this.notifications.length = 0;
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

export const window = {
  createOutputChannel,
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
  file: (fsPath: string) => ({ fsPath, scheme: "file", path: fsPath, toString: () => `file://${fsPath}` }),
  joinPath: (base: { fsPath: string }, ...parts: readonly string[]) => Uri.file([base.fsPath, ...parts].join("/")),
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
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const;
export const version = "1.96.0";
