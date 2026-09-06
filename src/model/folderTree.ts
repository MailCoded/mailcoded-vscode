import type { AccountDto, FolderDto } from "../protocol/index.js";

export type FolderNodeKind = "folder" | "group";

export interface FolderNode {
  readonly key: string;
  readonly accountId: number;
  readonly label: string;
  readonly path: string;
  readonly role: string | undefined;
  readonly folder: FolderDto | undefined;
  readonly unread: number;
  readonly total: number;
  readonly children: readonly FolderNode[];
}

export interface AccountNode {
  readonly key: string;
  readonly account: AccountDto;
  readonly unread: number;
  readonly total: number;
  readonly children: readonly FolderNode[];
}

const ROLE_ORDER: readonly string[] = ["inbox", "drafts", "sent", "trash", "junk", "archive", "all"];

export const FOLDER_DELIMITER = "/";

export function accountKey(accountId: number): string {
  return `a:${accountId}`;
}

export function folderKey(accountId: number, path: string): string {
  return `${accountKey(accountId)}/f:${path}`;
}

export function folderNodeKind(node: FolderNode): FolderNodeKind {
  return node.folder === undefined ? "group" : "folder";
}

export function buildFolderTree(account: AccountDto, folders: readonly FolderDto[]): AccountNode {
  const roots = collect(folders);
  sortAll(roots);
  const children = roots.map((root) => freeze(account.id, root));

  return {
    key: accountKey(account.id),
    account,
    unread: sum(children, (child) => child.unread),
    total: sum(children, (child) => child.total),
    children,
  };
}

interface Draft {
  readonly path: string;
  readonly label: string;
  folder: FolderDto | undefined;
  readonly children: Draft[];
}

function collect(folders: readonly FolderDto[]): Draft[] {
  const roots: Draft[] = [];
  const index = new Map<string, Draft>();
  const ordered = [...folders].sort((left, right) => compareText(left.name, right.name));

  for (const folder of ordered) {
    const segments = folder.name.split(FOLDER_DELIMITER).filter((segment) => segment.length > 0);
    let path = "";
    let parent: Draft | undefined;

    for (const segment of segments) {
      path = path === "" ? segment : `${path}${FOLDER_DELIMITER}${segment}`;
      const lookup = path.toLowerCase();
      let node = index.get(lookup);

      if (node === undefined) {
        // A server can list "Projects/Alpha" without listing "Projects"; the parent is still a
        // node, just one that holds no messages of its own.
        node = { path, label: segment, folder: undefined, children: [] };
        index.set(lookup, node);
        (parent === undefined ? roots : parent.children).push(node);
      }

      parent = node;
    }

    if (parent !== undefined) {
      parent.folder = folder;
    }
  }

  return roots;
}

function sortAll(nodes: Draft[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    sortAll(node.children);
  }
}

function compareNodes(left: Draft, right: Draft): number {
  const byRole = roleRank(left.folder?.role) - roleRank(right.folder?.role);
  return byRole !== 0 ? byRole : compareText(left.label, right.label);
}

function roleRank(role: string | undefined): number {
  if (role === undefined) {
    return ROLE_ORDER.length;
  }
  const at = ROLE_ORDER.indexOf(role.toLowerCase());
  return at < 0 ? ROLE_ORDER.length : at;
}

function compareText(left: string, right: string): number {
  const lower = left.toLowerCase();
  const upper = right.toLowerCase();
  if (lower !== upper) {
    return lower < upper ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function freeze(accountId: number, node: Draft): FolderNode {
  const children = node.children.map((child) => freeze(accountId, child));
  const own = node.folder;

  return {
    key: folderKey(accountId, node.path),
    accountId,
    label: node.label,
    path: node.path,
    role: own?.role,
    folder: own,
    unread: (own?.unread ?? 0) + sum(children, (child) => child.unread),
    total: (own?.total ?? 0) + sum(children, (child) => child.total),
    children,
  };
}

function sum(nodes: readonly FolderNode[], pick: (node: FolderNode) => number): number {
  let running = 0;
  for (const node of nodes) {
    running += pick(node);
  }
  return running;
}
