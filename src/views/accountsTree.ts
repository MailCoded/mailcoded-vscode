import * as vscode from "vscode";

import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import { RpcError } from "../daemon/types.js";
import type { DaemonNotification, DaemonStatus, Disposable } from "../daemon/types.js";
import { buildFolderTree } from "../model/folderTree.js";
import type { AccountNode, FolderNode } from "../model/folderTree.js";
import type { AccountDto, FolderDto, RpcMethodName } from "../protocol/index.js";

import { toTreeItem } from "./treeItems.js";
import type { AccountTreeNode, FolderTreeNode, MailcodedTreeNode } from "./treeItems.js";

export type { AccountTreeNode, FolderTreeNode, MailcodedTreeNode } from "./treeItems.js";

export const ACCOUNTS_VIEW_ID = "mailcoded.accounts";

/** An IDLE storm can emit one notification per message; the tree is rebuilt once per burst. */
const PATCH_DEBOUNCE_MS = 250;

const INBOX_ROLE = "inbox";

interface AccountEntry {
  readonly ref: AccountTreeNode;
  readonly byKey: Map<string, FolderTreeNode>;
  folders: FolderDto[];
}

type PendingFolders = Map<number, Map<number, FolderDto | undefined>>;

function isConnected(status: DaemonStatus): boolean {
  return status.state === "ready" || status.state === "secondary";
}

function replaceFolder(folders: FolderDto[], folder: FolderDto): void {
  const at = folders.findIndex((candidate) => candidate.id === folder.id);
  if (at < 0) {
    folders.push(folder);
    return;
  }
  folders[at] = folder;
}

/** The accounts and folders of `mailcoded.accounts`. Selecting a folder does nothing yet. */
export class AccountsTreeProvider implements vscode.TreeDataProvider<MailcodedTreeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<MailcodedTreeNode | undefined>();

  readonly onDidChangeTreeData: vscode.Event<MailcodedTreeNode | undefined> = this.#changed.event;

  readonly #supervisor: MailcodedDaemonSupervisor;
  readonly #subscriptions: Disposable[] = [];
  readonly #entries = new Map<number, AccountEntry>();

  #accounts: AccountTreeNode[] | undefined;
  #loading: Promise<AccountTreeNode[]> | undefined;
  #pending: PendingFolders = new Map();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #connected: boolean;
  #generation = 0;
  #disposed = false;

  constructor(supervisor: MailcodedDaemonSupervisor) {
    this.#supervisor = supervisor;
    this.#connected = isConnected(supervisor.status);
    this.#subscriptions.push(
      supervisor.onDidChangeStatus((status) => {
        this.#onStatus(status);
      }),
      supervisor.onNotification((notification) => {
        this.#onNotification(notification);
      }),
    );
  }

  /** Summed over inbox-role folders only: an 'All Mail' folder would count every message twice. */
  get inboxUnread(): number {
    let unread = 0;
    for (const entry of this.#entries.values()) {
      for (const folder of entry.folders) {
        if (folder.role === INBOX_ROLE) {
          unread += folder.unread;
        }
      }
    }
    return unread;
  }

  getTreeItem(element: MailcodedTreeNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  async getChildren(element?: MailcodedTreeNode): Promise<MailcodedTreeNode[]> {
    if (!isConnected(this.#supervisor.status)) {
      return [];
    }
    try {
      if (element === undefined) {
        return await this.#accountRefs();
      }
      const entry = this.#entries.get(element.accountId);
      return entry === undefined ? [] : this.#childRefs(entry, element.node.children);
    } catch (error: unknown) {
      this.#log("account.list", error);
      return [];
    }
  }

  refresh(): void {
    this.#generation += 1;
    this.#accounts = undefined;
    this.#loading = undefined;
    this.#entries.clear();
    this.#pending.clear();
    this.#clearTimer();
    this.#changed.fire(undefined);
  }

  /** Repaints one folder row instead of the tree: a burst of arrivals must not rebuild every account. */
  async refreshFolder(accountId: number, folderId: number): Promise<void> {
    const single: Map<number, FolderDto | undefined> = new Map([[folderId, undefined]]);
    await this.#apply(accountId, single);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#entries.clear();
    this.#pending.clear();
    this.#accounts = undefined;
    this.#loading = undefined;
    this.#changed.dispose();
  }

  #onStatus(status: DaemonStatus): void {
    const connected = isConnected(status);
    if (connected === this.#connected) {
      return;
    }
    this.#connected = connected;
    this.refresh();
  }

  #onNotification(notification: DaemonNotification): void {
    switch (notification.method) {
      case "notify.folder.updated":
        this.#queue(notification.params.accountId, notification.params.folder.id, notification.params.folder);
        return;
      case "notify.mail.added":
        this.#queue(notification.params.accountId, notification.params.folderId, undefined);
        return;
      default:
        return;
    }
  }

  #queue(accountId: number, folderId: number, folder: FolderDto | undefined): void {
    if (this.#disposed || this.#entries.get(accountId) === undefined) {
      return;
    }
    let folders = this.#pending.get(accountId);
    if (folders === undefined) {
      folders = new Map();
      this.#pending.set(accountId, folders);
    }
    if (folder !== undefined || !folders.has(folderId)) {
      folders.set(folderId, folder);
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, PATCH_DEBOUNCE_MS);
  }

  async #flush(): Promise<void> {
    const pending = this.#pending;
    this.#pending = new Map();
    for (const [accountId, folders] of pending) {
      await this.#apply(accountId, folders);
    }
  }

  async #apply(accountId: number, folders: Map<number, FolderDto | undefined>): Promise<void> {
    const entry = this.#entries.get(accountId);
    if (entry === undefined || folders.size === 0) {
      return;
    }

    const needsFetch = [...folders.values()].some((folder) => folder === undefined);
    const fetched = needsFetch ? await this.#fetchFolders(accountId) : undefined;
    if (this.#disposed || this.#entries.get(accountId) !== entry) {
      return;
    }

    if (fetched !== undefined) {
      entry.folders = [...fetched];
    }
    for (const folder of folders.values()) {
      if (folder !== undefined && (fetched === undefined || !fetched.some((known) => known.id === folder.id))) {
        replaceFolder(entry.folders, folder);
      }
    }

    const rebuilt = buildFolderTree(entry.ref.node.account, entry.folders);
    const byFolderId = this.#reconcile(entry, rebuilt);

    for (const folderId of folders.keys()) {
      const ref = byFolderId.get(folderId);
      this.#changed.fire(ref ?? entry.ref);
    }
  }

  async #accountRefs(): Promise<AccountTreeNode[]> {
    const cached = this.#accounts;
    if (cached !== undefined) {
      return cached;
    }
    this.#loading ??= this.#load();
    try {
      return await this.#loading;
    } finally {
      this.#loading = undefined;
    }
  }

  async #load(): Promise<AccountTreeNode[]> {
    const generation = this.#generation;
    const accounts = await this.#supervisor.client.accountList();
    const loaded: { account: AccountDto; folders: FolderDto[] }[] = [];

    for (const account of accounts) {
      loaded.push({ account, folders: [...((await this.#fetchFolders(account.id)) ?? [])] });
    }

    if (this.#disposed || generation !== this.#generation) {
      return [];
    }
    const refs = loaded.map(({ account, folders }) => this.#adopt(account, folders));
    this.#accounts = refs;
    return refs;
  }

  #adopt(account: AccountDto, folders: FolderDto[]): AccountTreeNode {
    const built = buildFolderTree(account, folders);
    const entry: AccountEntry = {
      ref: { kind: "account", key: built.key, accountId: account.id, node: built },
      byKey: new Map(),
      folders,
    };
    this.#entries.set(account.id, entry);
    this.#reconcile(entry, built);
    return entry.ref;
  }

  /** Keeps one object per key alive across a rebuild, so a scoped change event names an element
   * the view already knows and the new counts are already on it. */
  #reconcile(entry: AccountEntry, built: AccountNode): Map<number, FolderTreeNode> {
    entry.ref.node = built;

    const byFolderId = new Map<number, FolderTreeNode>();
    const live = new Set<string>();

    const visit = (nodes: readonly FolderNode[]): void => {
      for (const node of nodes) {
        live.add(node.key);
        const ref = this.#refFor(entry, node);
        const folder = node.folder;
        if (folder !== undefined) {
          byFolderId.set(folder.id, ref);
        }
        visit(node.children);
      }
    };
    visit(built.children);

    for (const key of [...entry.byKey.keys()]) {
      if (!live.has(key)) {
        entry.byKey.delete(key);
      }
    }
    return byFolderId;
  }

  #refFor(entry: AccountEntry, node: FolderNode): FolderTreeNode {
    const existing = entry.byKey.get(node.key);
    if (existing !== undefined) {
      existing.node = node;
      return existing;
    }
    const created: FolderTreeNode = {
      kind: "folder",
      key: node.key,
      accountId: entry.ref.accountId,
      node,
    };
    entry.byKey.set(node.key, created);
    return created;
  }

  #childRefs(entry: AccountEntry, nodes: readonly FolderNode[]): FolderTreeNode[] {
    return nodes.map((node) => this.#refFor(entry, node));
  }

  /** One unreachable account must not blank the whole tree. */
  async #fetchFolders(accountId: number): Promise<readonly FolderDto[] | undefined> {
    try {
      return await this.#supervisor.client.folderList(accountId);
    } catch (error: unknown) {
      this.#log("folder.list", error);
      return undefined;
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Method and code only: params and results carry mail content and credentials. */
  #log(method: RpcMethodName, error: unknown): void {
    const code = error instanceof RpcError ? String(error.code) : "no code";
    this.#supervisor.output.appendLine(`Accounts view: ${method} failed (${code})`);
  }
}
