import * as vscode from "vscode";

import type { AccountNode, FolderNode } from "../model/folderTree.js";
import { hardenLine } from "../model/messageFormat.js";

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

/** Folder names and display names are server-controlled: a bidi override or a tag-block sequence
 * would otherwise rewrite the row around it, and a control character would reach the terminal.
 * One implementation, in the model, so the two tables cannot drift apart. */
export function harden(text: string): string {
  return hardenLine(text);
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
