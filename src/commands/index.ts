import * as vscode from "vscode";

import { moveMessage, setTags as applyTagDelta } from "../daemon/client.js";
import { explain, isRpcError } from "../daemon/errors.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import type { DaemonStatus } from "../daemon/types.js";
import { hardenLine } from "../model/messageFormat.js";
import { ARCHIVE_ROLE, folderWithRole, moveTargets } from "../model/folderTree.js";
import type { AccountDto, EnvelopeDto, FolderDto } from "../protocol/index.js";
import { FlagNames, RpcErrorCode } from "../protocol/index.js";
import type { MessageReader, MessageTagger } from "../reader/messageDocument.js";
import type { ReaderPanel } from "../reader/readerPanel.js";
import type { FolderTreeNode } from "../views/accountsTree.js";
import type { FolderScope, MessageScope } from "../views/messagesTree.js";
import type { MailcodedStatusBar } from "../views/statusBar.js";
import { harden } from "../views/treeItems.js";

export const COMMAND_SHOW_DAEMON_LOG = "mailcoded.showDaemonLog";
export const COMMAND_SHOW_DAEMON_INFO = "mailcoded.showDaemonInfo";
export const COMMAND_RESTART_DAEMON = "mailcoded.restartDaemon";
export const COMMAND_REFRESH = "mailcoded.refresh";
export const COMMAND_SYNC = "mailcoded.sync";
export const COMMAND_SYNC_FOLDER = "mailcoded.syncFolder";
export const COMMAND_OPEN_FOLDER = "mailcoded.openFolder";
export const COMMAND_OPEN_MESSAGE = "mailcoded.openMessage";
export const COMMAND_LOAD_MORE = "mailcoded.loadMore";
export const COMMAND_SEARCH = "mailcoded.search";
export const COMMAND_MARK_READ = "mailcoded.markRead";
export const COMMAND_MARK_UNREAD = "mailcoded.markUnread";
export const COMMAND_TOGGLE_FLAG = "mailcoded.toggleFlag";
export const COMMAND_VIEW_HTML = "mailcoded.viewHtml";
export const COMMAND_VIEW_PLAIN_TEXT = "mailcoded.viewPlainText";
export const COMMAND_ARCHIVE = "mailcoded.archive";
export const COMMAND_MOVE_TO = "mailcoded.moveTo";

const SHOW_LOG = "Show Daemon Log";
const NO_ARCHIVE = "This account has no folder marked as Archive. Use Move to Folder instead.";
const NO_OTHER_FOLDER = "This account has no other folder to move the message into.";
const MOVE_TITLE = "Move Message to Folder";
const MOVE_PLACEHOLDER = "Choose a folder";
const FOLDER_LABEL_MAX = 60;
const ROLE_LABEL_MAX = 16;

const PICK_A_MESSAGE = "Select a message in the Mailcoded messages view first.";

const KNOWN_FLAGS: ReadonlySet<string> = new Set(Object.values(FlagNames));

/** Structural on purpose: the commands need the tree's cache cleared, not its node type. */
export interface RefreshableTree {
  refresh(): void;
}

/** The half of the messages view the commands drive; `MessagesTreeProvider` satisfies it. */
export interface MessagesView extends RefreshableTree {
  readonly scope: MessageScope | undefined;
  show(scope: MessageScope): void;
  loadMore(): Promise<void>;
  patch(envelope: EnvelopeDto): void;
}

/** Selection lives on the tree views, which `extension.ts` owns rather than this module. */
export interface CommandSelection {
  accountId(): number | undefined;
  message(): EnvelopeDto | undefined;
  revealMessages(): void;
}

export interface CommandDependencies {
  readonly tree: RefreshableTree;
  readonly statusBar: MailcodedStatusBar;
  readonly messages: MessagesView;
  readonly reader: MessageReader;
  readonly readerPanel: ReaderPanel;
  readonly tagger: MessageTagger;
  readonly selection: CommandSelection;
}

interface FolderTarget {
  readonly accountId: number;
  readonly folderId: number;
  readonly label: string;
}

function connected(status: DaemonStatus): status is Extract<DaemonStatus, { state: "ready" | "secondary" }> {
  return status.state === "ready" || status.state === "secondary";
}

function describe(status: DaemonStatus): string {
  const detail = status.detail;
  return `The mailcoded daemon is ${status.state}.${detail === undefined ? "" : ` ${detail}`}`;
}

/** A folder name arrives from the server, so it is hardened before it becomes a picker label. */
async function pickFolder(folders: readonly FolderDto[]): Promise<FolderDto | undefined> {
  if (folders.length === 0) {
    await vscode.window.showInformationMessage(NO_OTHER_FOLDER);
    return undefined;
  }
  const items = folders.map((folder) => ({
    label: hardenLine(folder.name, FOLDER_LABEL_MAX),
    description: folder.role === undefined ? "" : hardenLine(folder.role, ROLE_LABEL_MAX),
    folder,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    title: MOVE_TITLE,
    placeHolder: MOVE_PLACEHOLDER,
  });
  return chosen?.folder;
}

/** Filing a message, which is a folder move on the server and therefore reversible. There is no
 * delete here: a message moved to Trash is still a message in Trash. */
async function fileMessage(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  node: unknown,
  into: "archive" | "chosen",
): Promise<void> {
  const envelope = envelopeOf(node, deps);
  if (envelope === undefined) {
    await vscode.window.showInformationMessage(PICK_A_MESSAGE);
    return;
  }

  let folders: readonly FolderDto[];
  try {
    folders = await supervisor.client.folderList(envelope.accountId);
  } catch (error: unknown) {
    await offerLog(
      supervisor,
      explain(error, { operation: "Reading the folder list", accountId: envelope.accountId }).text,
      true,
    );
    return;
  }

  const destination =
    into === "archive"
      ? folderWithRole(folders, ARCHIVE_ROLE)
      : await pickFolder(moveTargets(folders, envelope.folderId));
  if (destination === undefined) {
    if (into === "archive") {
      await vscode.window.showInformationMessage(NO_ARCHIVE);
    }
    return;
  }
  if (destination.id === envelope.folderId) {
    return;
  }

  try {
    await moveMessage(supervisor.client, envelope.id, destination.id);
  } catch (error: unknown) {
    if (isAuthFailure(error)) {
      deps.statusBar.setNeedsSignIn(true);
    }
    await offerLog(
      supervisor,
      explain(error, { operation: "Moving the message", accountId: envelope.accountId }).text,
      true,
    );
    return;
  }

  // The message has left the folder the list is showing, and both counts moved with it.
  deps.messages.refresh();
  deps.tree.refresh();
}

async function offerLog(supervisor: MailcodedDaemonSupervisor, message: string, warn: boolean): Promise<void> {
  const chosen = warn
    ? await vscode.window.showWarningMessage(message, SHOW_LOG)
    : await vscode.window.showInformationMessage(message, SHOW_LOG);
  if (chosen === SHOW_LOG) {
    supervisor.output.show(true);
  }
}

function isAuthFailure(error: unknown): boolean {
  return isRpcError(error) && error.code === RpcErrorCode.Auth;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isFolderNode(value: unknown): value is FolderTreeNode {
  const ref = asRecord(value);
  return (
    ref?.["kind"] === "folder" &&
    typeof ref["accountId"] === "number" &&
    asRecord(ref["node"]) !== undefined
  );
}

function isMessageNode(value: unknown): value is { readonly envelope: EnvelopeDto } {
  const ref = asRecord(value);
  return ref?.["kind"] === "message" && typeof asRecord(ref["envelope"])?.["id"] === "number";
}

/** A context menu names its row; the palette names nothing, so the view's selection answers. */
function envelopeOf(node: unknown, deps: CommandDependencies): EnvelopeDto | undefined {
  return isMessageNode(node) ? node.envelope : deps.selection.message();
}

function folderScope(target: unknown): FolderScope | undefined {
  const ref = asRecord(target);
  const accountId = ref?.["accountId"];
  const folderId = ref?.["folderId"];
  const folderName = ref?.["folderName"];
  return typeof accountId === "number" && typeof folderId === "number" && typeof folderName === "string"
    ? { accountId, folderId, folderName }
    : undefined;
}

function carries(envelope: EnvelopeDto, flag: string): boolean {
  return envelope.flags.includes(flag) || envelope.tags.includes(flag);
}

/** `tags.set` returns the whole tag set and the daemon projects the flags in the same
 * transaction, so the row is re-derived rather than patched. */
function restamp(envelope: EnvelopeDto, tags: readonly string[]): EnvelopeDto {
  return { ...envelope, tags, flags: tags.filter((tag) => KNOWN_FLAGS.has(tag)) };
}

/** One writer for every tag change, so the reader and the list patch the row the same way. */
export function createMessageTagger(
  supervisor: MailcodedDaemonSupervisor,
  messages: MessagesView,
): MessageTagger {
  return {
    async setTags(envelope: EnvelopeDto, add: readonly string[], remove: readonly string[]): Promise<void> {
      const result = await applyTagDelta(supervisor.client, envelope.id, add, remove);
      messages.patch(restamp(envelope, result.tags));
    },
  };
}

/** A group row carries no folder of its own, so there is nothing on the server to sync. */
function folderTarget(node: unknown): FolderTarget | undefined {
  if (!isFolderNode(node)) {
    return undefined;
  }
  const folder = node.node.folder;
  return folder === undefined
    ? undefined
    : { accountId: node.accountId, folderId: folder.id, label: harden(folder.name) };
}

async function restartDaemon(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Restarting the mailcoded daemon" },
      () => supervisor.restart(),
    );
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Restarting the daemon" }).text, true);
    return;
  }

  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), true);
  }
}

async function showDaemonInfo(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), false);
    return;
  }

  let accounts: number;
  try {
    accounts = (await supervisor.client.accountList()).length;
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
    return;
  }

  const { capabilities } = status;
  const parts = [
    `Daemon ${status.daemonVersion}`,
    `${String(capabilities.methods.length)} methods`,
    `max search ${String(capabilities.maxSearchLimit)}`,
    `${String(accounts)} ${accounts === 1 ? "account" : "accounts"}`,
  ];
  if (status.state === "secondary") {
    parts.push("secondary instance, no notifications");
  }

  await offerLog(supervisor, parts.join(" · "), false);
}

async function syncAccounts(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
): Promise<void> {
  let accounts: readonly AccountDto[];
  try {
    accounts = await supervisor.client.accountList();
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
    return;
  }

  if (accounts.length === 0) {
    await vscode.window.showInformationMessage("There are no mail accounts to sync yet.");
    return;
  }

  const token = deps.statusBar.beginSync();
  let firstFailure: string | undefined;
  let authFailed = false;
  try {
    for (const account of accounts) {
      try {
        await supervisor.client.request("sync", { accountId: account.id });
      } catch (error: unknown) {
        authFailed = authFailed || isAuthFailure(error);
        firstFailure ??= explain(error, {
          operation: `Syncing ${account.email}`,
          accountId: account.id,
          accountName: account.email,
        }).text;
      }
    }
  } finally {
    token.dispose();
  }

  if (authFailed) {
    deps.statusBar.setNeedsSignIn(true);
  } else if (firstFailure === undefined) {
    deps.statusBar.setNeedsSignIn(false);
  }

  deps.tree.refresh();

  if (firstFailure !== undefined) {
    await offerLog(supervisor, firstFailure, true);
  }
}

async function syncFolder(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  node: unknown,
): Promise<void> {
  const target = folderTarget(node);
  if (target === undefined) {
    await vscode.window.showInformationMessage(
      "Sync Folder runs on one folder. Right-click a folder in the Mailcoded accounts view and choose it there.",
    );
    return;
  }

  const token = deps.statusBar.beginSync();
  let failure: string | undefined;
  try {
    await supervisor.client.request("sync", { accountId: target.accountId, folderId: target.folderId });
  } catch (error: unknown) {
    if (isAuthFailure(error)) {
      deps.statusBar.setNeedsSignIn(true);
    }
    failure = explain(error, { operation: `Syncing ${target.label}`, accountId: target.accountId }).text;
  } finally {
    token.dispose();
  }

  if (failure !== undefined) {
    await offerLog(supervisor, failure, true);
    return;
  }

  deps.statusBar.setNeedsSignIn(false);
  deps.tree.refresh();
}

function openFolder(deps: CommandDependencies, target: unknown): void {
  const scope = folderScope(target);
  if (scope === undefined) {
    return;
  }
  deps.messages.show(scope);
  deps.selection.revealMessages();
}

async function openMessage(deps: CommandDependencies, messageId: unknown): Promise<void> {
  if (typeof messageId !== "number") {
    await vscode.window.showInformationMessage(PICK_A_MESSAGE);
    return;
  }
  await deps.readerPanel.open(messageId);
}

/** A query is scoped to one account: the selected one, or the first the daemon lists. */
async function searchMail(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
): Promise<void> {
  let accountId = deps.selection.accountId();
  if (accountId === undefined) {
    let accounts: readonly AccountDto[];
    try {
      accounts = await supervisor.client.accountList();
    } catch (error: unknown) {
      await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
      return;
    }
    accountId = accounts[0]?.id;
  }
  if (accountId === undefined) {
    await vscode.window.showInformationMessage("There are no mail accounts to search yet.");
    return;
  }

  const typed = await vscode.window.showInputBox({
    title: "Search Mail",
    prompt:
      "Words, or from: to: subject: tag: is:unread has:attachment before: after:. Searched locally, " +
      "in relevance order.",
    placeHolder: "invoice from:acme",
    ignoreFocusOut: true,
  });
  const query = typed?.trim() ?? "";
  if (query === "") {
    return;
  }

  deps.messages.show({ accountId, query });
  deps.selection.revealMessages();
}

async function applyTags(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  envelope: EnvelopeDto,
  add: readonly string[],
  remove: readonly string[],
  operation: string,
): Promise<void> {
  try {
    await deps.tagger.setTags(envelope, add, remove);
  } catch (error: unknown) {
    if (isAuthFailure(error)) {
      deps.statusBar.setNeedsSignIn(true);
    }
    await offerLog(supervisor, explain(error, { operation, accountId: envelope.accountId }).text, true);
  }
}

async function changeTags(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  node: unknown,
  add: readonly string[],
  remove: readonly string[],
  operation: string,
): Promise<void> {
  const envelope = envelopeOf(node, deps);
  if (envelope === undefined) {
    await vscode.window.showInformationMessage(PICK_A_MESSAGE);
    return;
  }
  await applyTags(supervisor, deps, envelope, add, remove, operation);
}

async function toggleFlag(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
  node: unknown,
): Promise<void> {
  const envelope = envelopeOf(node, deps);
  if (envelope === undefined) {
    await vscode.window.showInformationMessage(PICK_A_MESSAGE);
    return;
  }
  const flagged = carries(envelope, FlagNames.Flagged);
  await applyTags(
    supervisor,
    deps,
    envelope,
    flagged ? [] : [FlagNames.Flagged],
    flagged ? [FlagNames.Flagged] : [],
    flagged ? "Clearing the flag" : "Flagging the message",
  );
}

/** Every declared command is registered here; a palette entry that answers "command not found"
 * is worse than an absent one, so the manifest and this list are checked against each other. */
export function registerCommands(
  supervisor: MailcodedDaemonSupervisor,
  deps: CommandDependencies,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_LOG, () => {
      supervisor.output.show(true);
    }),
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_INFO, () => showDaemonInfo(supervisor)),
    vscode.commands.registerCommand(COMMAND_RESTART_DAEMON, () => restartDaemon(supervisor)),
    vscode.commands.registerCommand(COMMAND_REFRESH, () => {
      deps.tree.refresh();
      deps.messages.refresh();
    }),
    vscode.commands.registerCommand(COMMAND_SYNC, () => syncAccounts(supervisor, deps)),
    vscode.commands.registerCommand(COMMAND_SYNC_FOLDER, (node: unknown) => syncFolder(supervisor, deps, node)),
    vscode.commands.registerCommand(COMMAND_OPEN_FOLDER, (target: unknown) => {
      openFolder(deps, target);
    }),
    vscode.commands.registerCommand(COMMAND_OPEN_MESSAGE, (messageId: unknown) => openMessage(deps, messageId)),
    vscode.commands.registerCommand(COMMAND_LOAD_MORE, () => deps.messages.loadMore()),
    vscode.commands.registerCommand(COMMAND_SEARCH, () => searchMail(supervisor, deps)),
    vscode.commands.registerCommand(COMMAND_MARK_READ, (node: unknown) =>
      changeTags(supervisor, deps, node, [], [FlagNames.Unread], "Marking the message read"),
    ),
    vscode.commands.registerCommand(COMMAND_MARK_UNREAD, (node: unknown) =>
      changeTags(supervisor, deps, node, [FlagNames.Unread], [], "Marking the message unread"),
    ),
    vscode.commands.registerCommand(COMMAND_TOGGLE_FLAG, (node: unknown) => toggleFlag(supervisor, deps, node)),
    vscode.commands.registerCommand(COMMAND_VIEW_HTML, () => deps.readerPanel.showHtml()),
    vscode.commands.registerCommand(COMMAND_VIEW_PLAIN_TEXT, () => deps.readerPanel.showText()),
    vscode.commands.registerCommand(COMMAND_ARCHIVE, (node: unknown) => fileMessage(supervisor, deps, node, "archive")),
    vscode.commands.registerCommand(COMMAND_MOVE_TO, (node: unknown) => fileMessage(supervisor, deps, node, "chosen")),
  );
}
