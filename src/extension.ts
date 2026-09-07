import * as vscode from "vscode";

import { createMessageTagger, registerCommands } from "./commands/index.js";
import type { CommandSelection } from "./commands/index.js";
import { createDaemonSupervisor } from "./daemon/supervisor.js";
import type { MailcodedDaemonSupervisor } from "./daemon/supervisor.js";
import type { DaemonStatus } from "./daemon/types.js";
import { ContextKeys } from "./context.js";
import { hardenLine } from "./model/messageFormat.js";
import type { EnvelopeDto } from "./protocol/index.js";
import { createMessageReader } from "./reader/messageDocument.js";
import { createReaderPanel } from "./reader/readerPanel.js";
import type { ReaderPanel } from "./reader/readerPanel.js";
import { ACCOUNTS_VIEW_ID, AccountsTreeProvider } from "./views/accountsTree.js";
import type { MailcodedTreeNode } from "./views/accountsTree.js";
import { MESSAGES_VIEW_ID, MessagesTreeProvider } from "./views/messagesTree.js";
import type { MessageTreeNode } from "./views/messagesTree.js";
import { createStatusBar } from "./views/statusBar.js";

export interface MailcodedApi {
  readonly supervisor: MailcodedDaemonSupervisor;
  readonly _test?: {
    readonly contextKeys: ContextKeys;
    readonly tree: AccountsTreeProvider;
    readonly messages: MessagesTreeProvider;
    readonly readerPanel: ReaderPanel;
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

function selectedEnvelope(view: vscode.TreeView<MessageTreeNode>): EnvelopeDto | undefined {
  for (const node of view.selection) {
    if (node.kind === "message") {
      return node.envelope;
    }
  }
  return undefined;
}

/** The count only exists once the page has loaded, and loading it fires no change event. */
async function updateMessagesTitle(
  view: vscode.TreeView<MessageTreeNode>,
  messages: MessagesTreeProvider,
): Promise<void> {
  await messages.getChildren();
  view.description = scopeTitle(messages);
}

function scopeTitle(messages: MessagesTreeProvider): string {
  const scope = messages.scope;
  if (scope === undefined) {
    return "";
  }
  const where = "folderName" in scope ? hardenLine(scope.folderName, 40) : `"${hardenLine(scope.query, 40)}"`;
  return `${where} · ${String(messages.messageCount)}`;
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
  const messages = new MessagesTreeProvider(supervisor);
  const messagesView = vscode.window.createTreeView<MessageTreeNode>(MESSAGES_VIEW_ID, {
    treeDataProvider: messages,
  });
  const tagger = createMessageTagger(supervisor, messages);
  const reader = createMessageReader(supervisor, tagger);
  const readerPanel = createReaderPanel(supervisor, context.extensionUri, tagger, reader);
  const statusBar = createStatusBar(supervisor);
  const badge = (): void => {
    void updateBadge(view, tree);
  };

  const selection: CommandSelection = {
    accountId: () => view.selection[0]?.accountId ?? messages.scope?.accountId,
    message: () => selectedEnvelope(messagesView),
    revealMessages: () => {
      if (!messagesView.visible) {
        void vscode.commands.executeCommand(`${MESSAGES_VIEW_ID}.focus`);
      }
    },
  };

  context.subscriptions.push(supervisor, keys, tree, view, messages, messagesView, reader, readerPanel, statusBar);
  context.subscriptions.push(tree.onDidChangeTreeData(badge));
  context.subscriptions.push(
    messages.onDidChangeTreeData(() => {
      void updateMessagesTitle(messagesView, messages);
    }),
  );
  context.subscriptions.push(
    supervisor.onDidChangeStatus((status) => {
      trackAccounts(supervisor, keys, status);
      if (status.state === "ready" || status.state === "secondary") {
        tree.refresh();
      }
    }),
  );
  context.subscriptions.push(
    registerCommands(supervisor, { tree, statusBar, messages, reader, readerPanel, tagger, selection }),
  );

  // Activation must not wait on a spawn or a handshake; the status event reports the outcome.
  void supervisor.start();

  return process.env["MAILCODED_TEST"] === "1"
    ? { supervisor, _test: { contextKeys: keys, tree, messages, readerPanel } }
    : { supervisor };
}

export function deactivate(): Thenable<void> {
  const supervisor = active;
  active = undefined;
  return supervisor === undefined ? Promise.resolve() : supervisor.stop();
}
