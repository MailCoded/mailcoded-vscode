import * as vscode from "vscode";

import { readConfiguration } from "../config.js";
import { getMessage } from "../daemon/client.js";
import { explain } from "../daemon/errors.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import { RpcError } from "../daemon/types.js";
import { hardenLine, messageDocument } from "../model/messageFormat.js";
import { FlagNames } from "../protocol/index.js";
import type { EnvelopeDto, MessageGetResult, RpcMethodName } from "../protocol/index.js";

export const MESSAGE_SCHEME = "mailcoded-message";

const PLAINTEXT_LANGUAGE_ID = "plaintext";
const SLUG_MAX = 60;
const SLUG_KEEP = /[\p{L}\p{N} ._-]/u;
const CACHED_MESSAGES = 20;
const DIGITS = /^[0-9]+$/;

/** How a tag change reaches the list; implemented once, in `commands`, over the messages view. */
export interface MessageTagger {
  setTags(envelope: EnvelopeDto, add: readonly string[], remove: readonly string[]): Promise<void>;
}

export interface MessageReader extends vscode.Disposable {
  open(messageId: number): Promise<void>;
}

/** Cosmetic. The id is the only part of the URI that identifies the message, and the subject is
 * attacker input, so it is hardened down to an allowlist before it is percent-encoded. */
export function documentSlug(subject: string | undefined): string {
  const hardened = hardenLine(subject, SLUG_MAX);
  const kept: string[] = [];
  for (const character of hardened) {
    kept.push(SLUG_KEEP.test(character) ? character : "-");
  }
  const slug = kept.join("").trim();
  return slug === "" ? "message" : slug;
}

export function messageUri(messageId: number, subject: string | undefined): vscode.Uri {
  const name = `${encodeURIComponent(documentSlug(subject))}.txt`;
  return vscode.Uri.parse(`${MESSAGE_SCHEME}:${String(messageId)}/${name}`, true);
}

export function messageIdOf(uri: vscode.Uri): number | undefined {
  const first = uri.path.replace(/^\/+/, "").split("/")[0] ?? "";
  return DIGITS.test(first) ? Number.parseInt(first, 10) : undefined;
}

function isUnread(envelope: EnvelopeDto): boolean {
  return envelope.flags.includes(FlagNames.Unread) || envelope.tags.includes(FlagNames.Unread);
}

/** A read-only plaintext document: a content provider's document is never editable, and this
 * reader never touches `bodyHtml`, which only the sandboxed webview may render. */
class MessageDocuments implements vscode.TextDocumentContentProvider, MessageReader {
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange: vscode.Event<vscode.Uri> = this.#changed.event;

  readonly #supervisor: MailcodedDaemonSupervisor;
  readonly #tagger: MessageTagger;
  readonly #cache = new Map<number, MessageGetResult>();
  readonly #registration: vscode.Disposable;

  constructor(supervisor: MailcodedDaemonSupervisor, tagger: MessageTagger) {
    this.#supervisor = supervisor;
    this.#tagger = tagger;
    this.#registration = vscode.workspace.registerTextDocumentContentProvider(MESSAGE_SCHEME, this);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const messageId = messageIdOf(uri);
    if (messageId === undefined) {
      return "This URI names no message.\n";
    }
    const cached = this.#cache.get(messageId);
    return messageDocument(cached ?? (await this.#fetch(messageId)));
  }

  async open(messageId: number): Promise<void> {
    let message: MessageGetResult;
    try {
      message = await this.#fetch(messageId);
    } catch (error: unknown) {
      this.#log("message.get", error);
      await vscode.window.showWarningMessage(explain(error, { operation: "Opening the message" }).text);
      return;
    }

    const uri = messageUri(messageId, message.envelope.subject);
    this.#changed.fire(uri);

    const opened = await vscode.workspace.openTextDocument(uri);
    const document = await vscode.languages.setTextDocumentLanguage(opened, PLAINTEXT_LANGUAGE_ID);
    await vscode.window.showTextDocument(document, { preview: true });

    await this.#markRead(message.envelope);
  }

  dispose(): void {
    this.#registration.dispose();
    this.#changed.dispose();
    this.#cache.clear();
  }

  async #fetch(messageId: number): Promise<MessageGetResult> {
    const message = await getMessage(this.#supervisor.client, messageId, true);
    this.#remember(messageId, message);
    return message;
  }

  /** Bodies are held only long enough for a repaint of the open document. */
  #remember(messageId: number, message: MessageGetResult): void {
    this.#cache.delete(messageId);
    this.#cache.set(messageId, message);
    for (const stale of [...this.#cache.keys()].slice(0, Math.max(0, this.#cache.size - CACHED_MESSAGES))) {
      this.#cache.delete(stale);
    }
  }

  /** The message is open either way, so a failed tag write is logged, not raised at the reader. */
  async #markRead(envelope: EnvelopeDto): Promise<void> {
    if (!readConfiguration().markReadOnOpen || !isUnread(envelope)) {
      return;
    }
    try {
      await this.#tagger.setTags(envelope, [], [FlagNames.Unread]);
    } catch (error: unknown) {
      this.#log("tags.set", error);
    }
  }

  /** Method and code only: params and results carry mail content. A disposed output channel
   * throws, and reporting a failure must never be what fails. */
  #log(method: RpcMethodName, error: unknown): void {
    const code = error instanceof RpcError ? String(error.code) : "no code";
    try {
      this.#supervisor.output.appendLine(`Message reader: ${method} failed (${code})`);
    } catch {
      return;
    }
  }
}

export function createMessageReader(
  supervisor: MailcodedDaemonSupervisor,
  tagger: MessageTagger,
): MessageReader {
  return new MessageDocuments(supervisor, tagger);
}
