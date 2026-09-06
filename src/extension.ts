import * as vscode from "vscode";

import { registerCommands } from "./commands/index.js";
import { createDaemonSupervisor } from "./daemon/supervisor.js";
import type { MailcodedDaemonSupervisor } from "./daemon/supervisor.js";
import type { DaemonStatus } from "./daemon/types.js";
import { ContextKeys } from "./context.js";
import { ACCOUNTS_VIEW_ID, AccountsTreeProvider } from "./views/accountsTree.js";
import type { MailcodedTreeNode } from "./views/accountsTree.js";
import { createStatusBar } from "./views/statusBar.js";

export interface MailcodedApi {
  readonly supervisor: MailcodedDaemonSupervisor;
  readonly _test?: {
    readonly contextKeys: ContextKeys;
    readonly tree: AccountsTreeProvider;
  };
}

let active: MailcodedDaemonSupervisor | undefined;

function trackAccounts(supervisor: MailcodedDaemonSupervisor, keys: ContextKeys, status: DaemonStatus): void {
  keys.setStatus(status);
  if (status.state !== "ready" && status.state !== "secondary") {
    keys.setAccountCount(undefined);
    return;
  }
  supervisor.client.accountList().then(
    (accounts) => {
      keys.setAccountCount(accounts.length);
    },
    () => {
      keys.setAccountCount(undefined);
    },
  );
}

/** The count only exists once the roots have loaded, and loading them fires no change event. */
async function updateBadge(
  view: vscode.TreeView<MailcodedTreeNode>,
  tree: AccountsTreeProvider,
): Promise<void> {
  await tree.getChildren();
  const unread = tree.inboxUnread;
  view.badge =
    unread > 0
      ? { value: unread, tooltip: `${String(unread)} unread ${unread === 1 ? "message" : "messages"}` }
      : undefined;
}

export function activate(context: vscode.ExtensionContext): MailcodedApi {
  const supervisor = createDaemonSupervisor(context);
  active = supervisor;

  const keys = new ContextKeys();
  const tree = new AccountsTreeProvider(supervisor);
  const view = vscode.window.createTreeView<MailcodedTreeNode>(ACCOUNTS_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = createStatusBar(supervisor);
  const badge = (): void => {
    void updateBadge(view, tree);
  };

  context.subscriptions.push(supervisor, keys, tree, view, statusBar);
  context.subscriptions.push(tree.onDidChangeTreeData(badge));
  context.subscriptions.push(
    supervisor.onDidChangeStatus((status) => {
      trackAccounts(supervisor, keys, status);
      if (status.state === "ready" || status.state === "secondary") {
        tree.refresh();
      }
    }),
  );
  context.subscriptions.push(registerCommands(supervisor, { tree, statusBar }));

  // Activation must not wait on a spawn or a handshake; the status event reports the outcome.
  void supervisor.start();

  return process.env["MAILCODED_TEST"] === "1"
    ? { supervisor, _test: { contextKeys: keys, tree } }
    : { supervisor };
}

export function deactivate(): Thenable<void> {
  const supervisor = active;
  active = undefined;
  return supervisor === undefined ? Promise.resolve() : supervisor.stop();
}
