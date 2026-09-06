import * as vscode from "vscode";

import { hardenLine, senderLabel, shortDate } from "../model/messageFormat.js";
import { FlagNames } from "../protocol/index.js";
import type { EnvelopeDto } from "../protocol/index.js";

export const OPEN_MESSAGE_COMMAND = "mailcoded.openMessage";
export const LOAD_MORE_COMMAND = "mailcoded.loadMore";

export interface MessageNode {
  readonly kind: "message";
  readonly envelope: EnvelopeDto;
}

/** Only what is already loaded is grouped; this phase never calls `thread.get`. */
export interface ThreadNode {
  readonly kind: "thread";
  readonly key: string;
  readonly envelopes: readonly EnvelopeDto[];
}

export interface LoadMoreNode {
  readonly kind: "loadMore";
}

export interface NoticeNode {
  readonly kind: "notice";
  readonly text: string;
  readonly detail: string;
}

export type MessageTreeNode = MessageNode | ThreadNode | LoadMoreNode | NoticeNode;

const NO_SUBJECT = "(no subject)";
const SUBJECT_MAX = 120;
const SENDER_MAX = 48;
const SNIPPET_MAX = 160;
const DATE_MAX = 32;

export function messageNode(envelope: EnvelopeDto): MessageNode {
  return { kind: "message", envelope };
}

export function threadNode(key: string, envelopes: readonly EnvelopeDto[]): ThreadNode {
  return { kind: "thread", key, envelopes };
}

export function loadMoreNode(): LoadMoreNode {
  return { kind: "loadMore" };
}

export function noticeNode(text: string, detail: string): NoticeNode {
  return { kind: "notice", text, detail };
}

function hasFlag(envelope: EnvelopeDto, flag: string): boolean {
  return envelope.flags.includes(flag);
}

function subjectOf(envelope: EnvelopeDto): string {
  const subject = hardenLine(envelope.subject, SUBJECT_MAX);
  return subject === "" ? NO_SUBJECT : subject;
}

function newest(envelopes: readonly EnvelopeDto[]): EnvelopeDto | undefined {
  let best: EnvelopeDto | undefined;
  for (const envelope of envelopes) {
    if (best === undefined || envelope.date > best.date) {
      best = envelope;
    }
  }
  return best;
}

function icon(envelope: EnvelopeDto): vscode.ThemeIcon {
  if (hasFlag(envelope, FlagNames.Flagged)) {
    return new vscode.ThemeIcon("star-full", new vscode.ThemeColor("charts.yellow"));
  }
  if (hasFlag(envelope, FlagNames.Unread)) {
    return new vscode.ThemeIcon("mail");
  }
  return new vscode.ThemeIcon(hasFlag(envelope, FlagNames.Answered) ? "mail-reply" : "mail-read");
}

function tooltip(envelope: EnvelopeDto): string {
  const lines = [
    subjectOf(envelope),
    `From: ${hardenLine(senderLabel(envelope), SENDER_MAX)}`,
    `Date: ${hardenLine(envelope.date, DATE_MAX)}`,
  ];
  if (envelope.hasAttachments) {
    lines.push("Attachments: yes");
  }
  const snippet = hardenLine(envelope.snippet, SNIPPET_MAX);
  if (snippet !== "") {
    lines.push(snippet);
  }
  return lines.join("\n");
}

function messageItem(node: MessageNode): vscode.TreeItem {
  const envelope = node.envelope;
  const item = new vscode.TreeItem(subjectOf(envelope), vscode.TreeItemCollapsibleState.None);

  item.id = `m:${String(envelope.id)}`;
  item.iconPath = icon(envelope);
  item.description = `${hardenLine(senderLabel(envelope), SENDER_MAX)} · ${hardenLine(
    shortDate(envelope.date, new Date()),
    DATE_MAX,
  )}`;
  item.contextValue = hasFlag(envelope, FlagNames.Unread) ? "message.unread" : "message.read";

  // A plain string, never a MarkdownString: a subject or a sender must not be able to plant a
  // clickable link in a tooltip.
  item.tooltip = tooltip(envelope);

  // The id only: no subject, sender or body ever travels through a command argument.
  item.command = { command: OPEN_MESSAGE_COMMAND, title: "Open Message", arguments: [envelope.id] };
  return item;
}

function threadItem(node: ThreadNode): vscode.TreeItem {
  const head = newest(node.envelopes) ?? node.envelopes[0];
  const count = node.envelopes.length;
  const label = head === undefined ? NO_SUBJECT : subjectOf(head);

  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `t:${node.key}`;
  item.iconPath = new vscode.ThemeIcon("comment-discussion");
  item.description = `${String(count)} messages`;
  item.contextValue = "thread";
  item.tooltip = `${label}\n${String(count)} loaded messages share this conversation. Only messages already loaded are grouped; the rest of the conversation is not fetched.`;
  return item;
}

function loadMoreItem(): vscode.TreeItem {
  const item = new vscode.TreeItem("Load more…", vscode.TreeItemCollapsibleState.None);
  item.id = "more";
  item.iconPath = new vscode.ThemeIcon("ellipsis");
  item.contextValue = "loadMore";
  item.tooltip = "Fetch the next page of messages.";
  item.command = { command: LOAD_MORE_COMMAND, title: "Load More Messages" };
  return item;
}

function noticeItem(node: NoticeNode): vscode.TreeItem {
  const item = new vscode.TreeItem(hardenLine(node.text), vscode.TreeItemCollapsibleState.None);
  item.id = "notice";
  item.iconPath = new vscode.ThemeIcon("info");
  item.contextValue = "notice";
  item.tooltip = hardenLine(node.detail);
  return item;
}

export function toTreeItem(node: MessageTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "message":
      return messageItem(node);
    case "thread":
      return threadItem(node);
    case "loadMore":
      return loadMoreItem();
    case "notice":
      return noticeItem(node);
  }
}
