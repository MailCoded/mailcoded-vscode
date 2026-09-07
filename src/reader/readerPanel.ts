import { homedir } from "node:os";

import * as vscode from "vscode";

import { CONFIG_SECTION } from "../config.js";
import { getMessage, getMessageHtmlForWebview } from "../daemon/client.js";
import { explain } from "../daemon/errors.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import { hardenLine } from "../model/messageFormat.js";
import type { AttachmentDto, EnvelopeDto, MessageGetResult } from "../protocol/index.js";

import { isBase64, resolveInlineImages } from "./inlineImages.js";
import { logReaderFailure, markMessageRead } from "./messageDocument.js";
import type { MessageReader, MessageTagger } from "./messageDocument.js";
import { MAX_IMAGE_ORIGINS, messageTypeOf, parseHostMessage, parseWebviewMessage } from "./protocol.js";
import { buildShell, createNonce, READER_STYLES } from "./shell.js";

export const READER_VIEW_TYPE = "mailcoded.reader";

/** Derived from the guards rather than named, so the protocol module stays the single definition. */
type HostFrame = NonNullable<ReturnType<typeof parseHostMessage>>;
type RenderFrame = Extract<HostFrame, { type: "render" }>;
type StatusFrame = Extract<HostFrame, { type: "status" }>;
type RenderMode = RenderFrame["mode"];
type RenderHeader = RenderFrame["header"];
type RenderAttachment = RenderFrame["attachments"][number];

const READER_LABEL = "HTML reader";
const TITLE_MAX = 60;
const HEADER_MAX = 400;
const TAG_MAX = 40;
const TAGS_MAX = 20;
const ATTACHMENTS_MAX = 50;
const ATTACHMENT_INDEX_MAX = 10_000;
const CACHED_MESSAGES = 20;
const BLOCKED_MESSAGES = 32;
const ALLOWED_ORIGINS_MAX = MAX_IMAGE_ORIGINS;
const ORIGIN_MAX = 255;
const BODY_HTML_MAX = 4 * 1024 * 1024;
const ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
const FILENAME_MAX = 80;
const HREF_MAX = 4096;
const PORT_MAX = 65_535;

const NO_SUBJECT = "(no subject)";
const NO_SENDER = "(unknown sender)";
const NO_RECIPIENT = "(none)";
const NO_FILENAME = "(unnamed)";
const MIME_FALLBACK = "application/octet-stream";

const NO_MESSAGE_OPEN = "Open a message first: the reader has nothing to show.";
const NO_HTML_PART = "This message has no HTML part, so the plaintext is what you get.";
const HTML_TOO_LARGE = "This message's HTML part is too large to render; showing the plaintext.";
const HTML_FAILED = "The HTML part could not be loaded; showing the plaintext.";
const NOTHING_TO_ALLOW = "No image origin in this message could be allowed.";
const LOADING_HTML = "Loading the HTML part…";
const WRITE_FAILED = "The attachment could not be written to that location.";

/** `https://host` or `https://host:port`, and nothing else: no path, no userinfo, no wildcard.
 * These are the only strings that may ever widen the image policy of a single render. */
const ORIGIN =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

/** A bare `type/subtype`, lower case: a `Content-Type` with parameters would be refused by the
 * protocol guard, and one bad attachment must not cost the whole render. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

const FILENAME_KEEP = /[\p{L}\p{N}._-]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DOT_RUN = /\.{2,}/g;
const LEADING_JUNK = /^[._-]+/;

export interface ReaderPanel extends vscode.Disposable {
  open(messageId: number): Promise<void>;
  showHtml(): Promise<void>;
  showText(): Promise<void>;
  /** A violation means our sanitiser let something through, so it is countable, not silent. */
  cspViolations(): number;
}

interface CachedMessage {
  readonly envelope: EnvelopeDto;
  readonly text: RenderFrame;
  readonly html?: RenderFrame;
}

/** What decides whether the shell must be reloaded: it must change whenever the policy would,
 * and never otherwise, or opening the next message would cost a reload. */
function policyKey(origins: readonly string[]): string {
  return origins.length === 0 ? "no-remote-images" : `remote ${[...origins].sort().join(" ")}`;
}

function validOrigins(origins: readonly string[]): readonly string[] {
  const kept = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length > ORIGIN_MAX) {
      continue;
    }
    const lowered = origin.trim().toLowerCase();
    const port = lowered.split(":")[2];
    if (ORIGIN.test(lowered) && (port === undefined || Number.parseInt(port, 10) <= PORT_MAX)) {
      kept.add(lowered);
    }
  }
  return [...kept].sort().slice(0, ALLOWED_ORIGINS_MAX);
}

function readableDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return hardenLine(iso, 40);
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Headers are attacker input and reach the webview as data, so they are hardened here first. */
function renderHeader(envelope: EnvelopeDto): RenderHeader {
  const cc = hardenLine(envelope.cc, HEADER_MAX);
  const header = {
    subject: hardenLine(envelope.subject, HEADER_MAX) || NO_SUBJECT,
    from: hardenLine(envelope.from, HEADER_MAX) || NO_SENDER,
    to: hardenLine(envelope.to, HEADER_MAX) || NO_RECIPIENT,
    date: readableDate(envelope.date),
    tags: envelope.tags
      .map((tag) => hardenLine(tag, TAG_MAX))
      .filter((tag) => tag !== "")
      .slice(0, TAGS_MAX),
  };
  return cc === "" ? header : { ...header, cc };
}

function title(envelope: EnvelopeDto): string {
  return hardenLine(envelope.subject, TITLE_MAX) || NO_SUBJECT;
}

function mimeType(mime: unknown): string {
  if (typeof mime !== "string") {
    return MIME_FALLBACK;
  }
  const bare = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return MIME_SHAPE.test(bare) ? bare : MIME_FALLBACK;
}

function renderAttachments(attachments: readonly AttachmentDto[]): readonly RenderAttachment[] {
  const kept: RenderAttachment[] = [];
  for (const attachment of attachments) {
    if (kept.length >= ATTACHMENTS_MAX) {
      break;
    }
    const index = attachment.index;
    if (!Number.isSafeInteger(index) || index < 0 || index > ATTACHMENT_INDEX_MAX) {
      continue;
    }
    kept.push({
      index,
      filename: hardenLine(attachment.filename, FILENAME_MAX) || NO_FILENAME,
      mime: mimeType(attachment.mime),
      size: Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0,
    });
  }
  return kept;
}

/** A save-as default, not a path: one segment, joined with `Uri.joinPath`, never concatenated. */
function saveName(filename: string | undefined): string {
  const kept = [...hardenLine(filename, FILENAME_MAX)]
    .map((character) => (FILENAME_KEEP.test(character) ? character : "_"))
    .join("")
    .replace(DOT_RUN, ".")
    .replace(LEADING_JUNK, "");
  if (kept === "" || kept === ".") {
    return "attachment";
  }
  return WINDOWS_DEVICE.test(kept) ? `_${kept}` : kept;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value === "" || value.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 || !isBase64(value)) {
    return undefined;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function saveFolder(): vscode.Uri {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
}

class ReaderWebviewPanel implements ReaderPanel {
  readonly #supervisor: MailcodedDaemonSupervisor;
  readonly #extensionUri: vscode.Uri;
  readonly #tagger: MessageTagger;
  readonly #fallback: MessageReader;

  readonly #cache = new Map<number, CachedMessage>();
  readonly #blocked = new Map<number, readonly string[]>();
  readonly #subscriptions: vscode.Disposable[] = [];

  #panel: vscode.WebviewPanel | undefined;
  #loadedPolicyKey: string | undefined;
  #ready = false;
  #pending: RenderFrame | undefined;
  #current: RenderFrame | undefined;
  #chosen: RenderMode | undefined;
  #violations = 0;

  constructor(
    supervisor: MailcodedDaemonSupervisor,
    extensionUri: vscode.Uri,
    tagger: MessageTagger,
    fallback: MessageReader,
  ) {
    this.#supervisor = supervisor;
    this.#extensionUri = extensionUri;
    this.#tagger = tagger;
    this.#fallback = fallback;
  }

  cspViolations(): number {
    return this.#violations;
  }

  async open(messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      return;
    }

    const panel = this.#ensurePanel();
    if (panel === undefined) {
      await this.#fallback.open(messageId);
      return;
    }

    const cached = this.#cache.get(messageId);
    if (cached !== undefined) {
      panel.title = title(cached.envelope);
      panel.reveal(panel.viewColumn, true);
      this.#post(cached.text);
      await this.#upgrade(messageId);
      return;
    }

    let message: MessageGetResult;
    try {
      message = await getMessage(this.#supervisor.client, messageId, true);
    } catch (error: unknown) {
      logReaderFailure(this.#supervisor, READER_LABEL, "message.get", error);
      await vscode.window.showWarningMessage(explain(error, { operation: "Opening the message" }).text);
      return;
    }

    const text = this.#frame({
      messageId,
      mode: "text",
      header: renderHeader(message.envelope),
      bodyText: message.bodyText ?? "",
      attachments: renderAttachments(message.attachments),
      inlineImages: {},
      allowedOrigins: [],
    });
    if (text === undefined) {
      await this.#fallback.open(messageId);
      return;
    }

    this.#remember(messageId, { envelope: message.envelope, text });
    panel.title = title(message.envelope);
    panel.reveal(panel.viewColumn, true);
    this.#post(text);

    await markMessageRead(this.#supervisor, this.#tagger, READER_LABEL, message.envelope);
    await this.#upgrade(messageId);
  }

  async showHtml(): Promise<void> {
    this.#chosen = "html";
    const messageId = this.#current?.messageId;
    if (messageId === undefined) {
      await vscode.window.showInformationMessage(NO_MESSAGE_OPEN);
      return;
    }
    await this.#renderHtml(messageId);
  }

  async showText(): Promise<void> {
    this.#chosen = "text";
    const messageId = this.#current?.messageId;
    if (messageId === undefined) {
      await vscode.window.showInformationMessage(NO_MESSAGE_OPEN);
      return;
    }
    const cached = this.#cache.get(messageId);
    if (cached === undefined) {
      await this.open(messageId);
      return;
    }
    this.#post(cached.text);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#panel?.dispose();
    this.#forget();
  }

  /** Plaintext is what a message opens as unless the user has said otherwise in this session;
   * the setting only chooses the mode, and it is never written back. */
  #mode(): RenderMode {
    if (this.#chosen !== undefined) {
      return this.#chosen;
    }
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get("readerDefault") === "html"
      ? "html"
      : "text";
  }

  async #upgrade(messageId: number): Promise<void> {
    if (this.#mode() === "html") {
      await this.#renderHtml(messageId);
    }
  }

  /** The host validates what it is about to send with the same guard the webview validates on
   * receipt, so a bug here cannot put a malformed frame in front of the sanitiser. */
  #frame(fields: Omit<RenderFrame, "type">): RenderFrame | undefined {
    const parsed = parseHostMessage({ type: "render", ...fields });
    if (parsed?.type === "render") {
      return parsed;
    }
    this.#note("refused to post a render frame that did not validate");
    return undefined;
  }

  /** `bodyHtml` is raw attacker HTML. It travels as data, by `postMessage`, to a webview that
   * sanitises it; it is never interpolated into the shell and never touches the host DOM. */
  async #renderHtml(messageId: number): Promise<void> {
    const cached = this.#cache.get(messageId);
    if (cached === undefined) {
      return;
    }
    if (cached.html !== undefined) {
      this.#post({ ...cached.html, allowedOrigins: [] });
      return;
    }

    this.#status(LOADING_HTML);

    let message: MessageGetResult;
    try {
      message = await getMessageHtmlForWebview(this.#supervisor.client, messageId, true);
    } catch (error: unknown) {
      logReaderFailure(this.#supervisor, READER_LABEL, "message.get", error);
      this.#post(cached.text);
      await vscode.window.showWarningMessage(HTML_FAILED);
      return;
    }

    const bodyHtml = message.bodyHtml ?? "";
    if (bodyHtml.trim() === "") {
      this.#post(cached.text);
      await vscode.window.showInformationMessage(NO_HTML_PART);
      return;
    }
    if (bodyHtml.length > BODY_HTML_MAX) {
      this.#post(cached.text);
      await vscode.window.showWarningMessage(HTML_TOO_LARGE);
      return;
    }

    const inline = await resolveInlineImages(this.#supervisor.client, messageId, message.attachments);
    const html = this.#frame({
      messageId,
      mode: "html",
      header: renderHeader(message.envelope),
      bodyHtml,
      bodyText: message.bodyText ?? cached.text.bodyText ?? "",
      attachments: renderAttachments(message.attachments),
      inlineImages: inline.images,
      allowedOrigins: [],
    });
    if (html === undefined) {
      this.#post(cached.text);
      await vscode.window.showWarningMessage(HTML_FAILED);
      return;
    }

    this.#remember(messageId, { envelope: message.envelope, text: cached.text, html });
    this.#post(html);
  }

  #ensurePanel(): vscode.WebviewPanel | undefined {
    if (this.#panel !== undefined) {
      return this.#panel;
    }

    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(READER_VIEW_TYPE, NO_SUBJECT, vscode.ViewColumn.Active, {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.#extensionUri, "dist", "webview")],
      });
    } catch {
      this.#note("panel could not be created; falling back to the plaintext reader");
      return undefined;
    }

    this.#panel = panel;
    this.#loadedPolicyKey = undefined;
    this.#ready = false;
    this.#subscriptions.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void this.#receive(raw);
      }),
      panel.onDidDispose(() => {
        this.#panel = undefined;
        this.#forget();
      }),
    );
    return panel;
  }

  /** Mail bodies live in this panel's memory and nowhere else, so they go when it does. */
  #forget(): void {
    this.#loadedPolicyKey = undefined;
    this.#ready = false;
    this.#pending = undefined;
    this.#current = undefined;
    this.#cache.clear();
    this.#blocked.clear();
  }

  #post(render: RenderFrame): void {
    const panel = this.#ensurePanel();
    if (panel === undefined) {
      return;
    }

    const key = policyKey(render.allowedOrigins);
    if (key !== this.#loadedPolicyKey) {
      if (!this.#load(panel, render.allowedOrigins)) {
        return;
      }
      this.#loadedPolicyKey = key;
    }

    this.#current = render;
    if (this.#ready) {
      void panel.webview.postMessage(render);
      return;
    }
    this.#pending = render;
  }

  /** A reload is what swaps the policy, so it gets a fresh nonce, and the frame is re-posted once
   * the new document says it is ready. A shell that will not build renders nothing. */
  #load(panel: vscode.WebviewPanel, allowedOrigins: readonly string[]): boolean {
    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.#extensionUri, "dist", "webview", "main.js"))
      .toString();
    const options = {
      nonce: createNonce(),
      cspSource: panel.webview.cspSource,
      scriptUri,
      styles: READER_STYLES,
    };

    let html: string;
    try {
      html = buildShell(allowedOrigins.length === 0 ? options : { ...options, allowedOrigins });
    } catch {
      this.#note("refused a reader shell whose content policy would not build");
      return false;
    }

    this.#ready = false;
    this.#pending = undefined;
    panel.webview.html = html;
    return true;
  }

  #status(text: string): void {
    if (this.#panel === undefined || !this.#ready) {
      return;
    }
    const status = parseHostMessage({ type: "status", text });
    if (status?.type !== "status") {
      return;
    }
    const frame: StatusFrame = status;
    void this.#panel.webview.postMessage(frame);
  }

  async #receive(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (message === undefined) {
      this.#note(`ignored a '${messageTypeOf(raw)}' message from the reader`);
      return;
    }

    switch (message.type) {
      case "ready": {
        this.#ready = true;
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending !== undefined) {
          void this.#panel?.webview.postMessage(pending);
        }
        return;
      }
      case "blockedImages":
        this.#rememberBlocked(message.messageId, message.origins);
        return;
      case "allowRemote":
        this.#allowRemote(message.messageId);
        return;
      case "openLink":
        this.#openLink(message.href);
        return;
      case "saveAttachment":
        await this.#saveAttachment(message.index);
        return;
      case "viewHtml":
        await this.showHtml();
        return;
      case "viewText":
        await this.showText();
        return;
      case "cspViolation":
        this.#violations += 1;
        this.#note(`blocked ${message.directive} from ${message.blockedOrigin}`);
        return;
      case "rendered":
        this.#note(`rendered a message in ${String(Math.round(message.elapsedMs))} ms`);
        return;
    }
  }

  #rememberBlocked(messageId: number, origins: readonly string[]): void {
    if (this.#current?.messageId !== messageId) {
      return;
    }
    const valid = validOrigins(origins);
    if (valid.length === 0) {
      return;
    }
    this.#blocked.delete(messageId);
    this.#blocked.set(messageId, valid);
    for (const stale of [...this.#blocked.keys()].slice(0, Math.max(0, this.#blocked.size - BLOCKED_MESSAGES))) {
      this.#blocked.delete(stale);
    }
  }

  /** The allow covers one render of one message. Opening anything else, or switching to text,
   * computes the strict policy key again and therefore drops it. */
  #allowRemote(messageId: number): void {
    const current = this.#current;
    if (current === undefined || current.messageId !== messageId || current.mode !== "html") {
      return;
    }
    const origins = validOrigins(this.#blocked.get(messageId) ?? []);
    if (origins.length === 0) {
      this.#status(NOTHING_TO_ALLOW);
      return;
    }
    this.#post({ ...(this.#cache.get(messageId)?.html ?? current), allowedOrigins: origins });
  }

  #openLink(href: string): void {
    if (href.length > HREF_MAX) {
      this.#note("dropped a link that was implausibly long");
      return;
    }

    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      this.#note("dropped a link that is not a URI");
      return;
    }

    const scheme = uri.scheme.toLowerCase();
    if (scheme !== "https" && scheme !== "mailto") {
      this.#note(`dropped a ${hardenLine(scheme, 16)} link`);
      return;
    }
    void vscode.env.openExternal(uri);
  }

  async #saveAttachment(index: number): Promise<void> {
    const current = this.#current;
    if (current === undefined) {
      return;
    }
    if (current.attachments.every((candidate) => candidate.index !== index)) {
      return;
    }

    const messageId = current.messageId;
    let bytes: Uint8Array | undefined;
    let filename: string;
    try {
      const blob = await this.#supervisor.client.request("attachment.get", { messageId, index });
      bytes = decodeBase64(blob.base64);
      filename = saveName(blob.filename);
    } catch (error: unknown) {
      logReaderFailure(this.#supervisor, READER_LABEL, "attachment.get", error);
      await vscode.window.showWarningMessage(explain(error, { operation: "Saving the attachment" }).text);
      return;
    }

    if (bytes === undefined) {
      this.#note("refused an attachment whose bytes did not decode");
      return;
    }

    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(saveFolder(), filename),
      saveLabel: "Save Attachment",
    });
    if (target === undefined) {
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(target, bytes);
    } catch {
      await vscode.window.showWarningMessage(WRITE_FAILED);
    }
  }

  #remember(messageId: number, entry: CachedMessage): void {
    this.#cache.delete(messageId);
    this.#cache.set(messageId, entry);
    for (const stale of [...this.#cache.keys()].slice(0, Math.max(0, this.#cache.size - CACHED_MESSAGES))) {
      this.#cache.delete(stale);
    }
  }

  /** Never a header, a body, a filename or a URL: this log carries our own words, and the
   * directive and origin the protocol guard has already reduced to a bare origin. */
  #note(what: string): void {
    try {
      this.#supervisor.output.appendLine(`${READER_LABEL}: ${what}`);
    } catch {
      return;
    }
  }
}

export function createReaderPanel(
  supervisor: MailcodedDaemonSupervisor,
  extensionUri: vscode.Uri,
  tagger: MessageTagger,
  fallback: MessageReader,
): ReaderPanel {
  return new ReaderWebviewPanel(supervisor, extensionUri, tagger, fallback);
}
