import * as vscode from "vscode";

import type { AccountNode, FolderNode } from "../model/folderTree.js";

/** Identity the tree view holds on to: `node` is replaced in place when counts change, so a
 * scoped `onDidChangeTreeData` still names an element VS Code recognises. */
export interface AccountTreeNode {
  readonly kind: "account";
  readonly key: string;
  readonly accountId: number;
  node: AccountNode;
}

export interface FolderTreeNode {
  readonly kind: "folder";
  readonly key: string;
  readonly accountId: number;
  node: FolderNode;
}

export type MailcodedTreeNode = AccountTreeNode | FolderTreeNode;

/** C0 and C1 controls, the zero-width and bidi overrides, and the tag block. Tab, newline and the
 * other whitespace controls are absent on purpose: the collapse below turns them into a space. */
const STRIPPED: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const WHITESPACE = /\s+/g;
const ELLIPSIS = "\u2026";
const MAX_LENGTH = 200;

const ROLE_ICONS: Readonly<Record<string, string>> = {
  inbox: "inbox",
  drafts: "edit",
  sent: "send",
  trash: "trash",
  junk: "warning",
  archive: "archive",
  all: "mail",
};

const FOLDER_ICON = "folder";

function isStripped(point: number): boolean {
  for (const [low, high] of STRIPPED) {
    if (point >= low && point <= high) {
      return true;
    }
  }
  return false;
}

/** Folder names and display names are server-controlled: a bidi override or a tag-block sequence
 * would otherwise rewrite the row around it, and a control character would reach the terminal. */
export function harden(text: string): string {
  const kept: string[] = [];
  for (const character of text) {
    if (!isStripped(character.codePointAt(0) ?? 0)) {
      kept.push(character);
    }
  }

  const collapsed = kept.join("").replace(WHITESPACE, " ").trim();
  const points = Array.from(collapsed);
  return points.length <= MAX_LENGTH
    ? collapsed
    : `${points.slice(0, MAX_LENGTH - 1).join("")}${ELLIPSIS}`;
}

function counts(unread: number, total: number): string {
  return `${String(unread)} unread of ${String(total)}`;
}

function folderIcon(node: FolderNode): vscode.ThemeIcon {
  if (node.folder === undefined) {
    return new vscode.ThemeIcon(FOLDER_ICON);
  }
  const role = node.role;
  const icon = role === undefined ? undefined : ROLE_ICONS[role];
  return new vscode.ThemeIcon(icon ?? FOLDER_ICON);
}

function accountItem(ref: AccountTreeNode): vscode.TreeItem {
  const { account, unread, total } = ref.node;
  const email = harden(account.email);
  const item = new vscode.TreeItem(email, vscode.TreeItemCollapsibleState.Expanded);
  item.id = ref.key;
  item.iconPath = new vscode.ThemeIcon("account");
  item.contextValue = "account";

  const displayName = account.displayName;
  const named = displayName === undefined ? "" : harden(displayName);
  if (named !== "") {
    item.description = named;
  }

  // A plain string, never a MarkdownString: a folder or display name must not be able to plant a
  // clickable link in a tooltip.
  item.tooltip = [named, email, harden(account.provider), counts(unread, total)]
    .filter((part) => part !== "")
    .join(" · ");
  return item;
}

function folderItem(ref: FolderTreeNode): vscode.TreeItem {
  const node = ref.node;
  const collapsibleState =
    node.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

  const item = new vscode.TreeItem(harden(node.label), collapsibleState);
  item.id = ref.key;
  item.iconPath = folderIcon(node);
  item.contextValue = node.folder === undefined ? "folderGroup" : "folder";

  if (node.unread > 0) {
    item.description = String(node.unread);
  }

  // A plain string, never a MarkdownString: a folder name must not be able to plant a clickable
  // link in a tooltip.
  item.tooltip =
    node.folder === undefined
      ? harden(node.path)
      : `${harden(node.path)} · ${counts(node.unread, node.total)}`;
  return item;
}

export function toTreeItem(ref: MailcodedTreeNode): vscode.TreeItem {
  return ref.kind === "account" ? accountItem(ref) : folderItem(ref);
}
