import { ShellElementIds } from "../reader/protocol.js";
import type { RenderAttachment, RenderMessage, WebviewToHostMessage } from "../reader/protocol.js";

import type { BodySanitizer } from "./sanitize.js";

const NO_SUBJECT = "(no subject)";
const NO_SENDER = "(unknown sender)";
const NO_RECIPIENT = "(none)";
const NO_FILENAME = "(unnamed)";
const NO_BODY = "(this message has no plaintext part)";

const VIEW_HTML = "View HTML";
const VIEW_TEXT = "View plain text";
const LOAD_IMAGES = "Load images for this message";
const IMAGES_LOADED = "Remote images are loaded for this message.";
const SAVE = "Save";

const ELEMENT_NODE = 1;
const ANCHOR = "a";

/** Deliberately narrow: no scheme-relative form, no `http:`, no credentials, no whitespace. */
const HTTPS_IN_TEXT = /https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
const TRAILING_PUNCTUATION = /[).,;:!?'"\]}>]+$/;
const SAFE_LINK = /^(?:https:|mailto:)/i;

const MAIL_WRAPPER = "mc-mail";

/** Lives inside the shadow root with the mail, which is the only place a rule can reach it. The
 * light-DOM stylesheet keeps the container's own containment and measure. */
const MAIL_STYLES = `
/* Mail is written for a sheet of white paper. Rendering it on the editor's background makes any
   newsletter that sets only a colour, or only a background, unreadable in half the themes: black
   text on a dark editor, or the editor's pale text on the mail's own light table. The chrome above
   stays themed; the message is a sheet. A mail rule for the body selector is rewritten onto this
   class by the sanitiser and wins by source order, so mail with its own palette still gets it. */
.${MAIL_WRAPPER} {
  color-scheme: light;
  background-color: #ffffff;
  color: #1f1f1f;
  padding: 1rem;
  overflow-wrap: break-word;
}
/* Zero specificity, so any rule the mail brings wins outright. Fixed colours rather than theme
   variables: on this canvas a theme-derived grey would be invisible in half the themes. */
:where(a[href]) { color: #0b57d0; text-decoration: underline; }
:where(a[href]:hover) { color: #0842a0; }
:where(blockquote) { margin: 0.6rem 0; padding-left: 0.8rem; border-left: 3px solid #d0d0d0; color: #4a4a4a; }
:where(hr) { border: 0; border-top: 1px solid #d0d0d0; }
:where(h1, h2, h3) { line-height: 1.25; }
:where(pre, code) { font-family: var(--vscode-editor-font-family, monospace); overflow-x: auto; white-space: pre-wrap; }
:where(table) { max-width: 100%; }
:where(td, th) { overflow-wrap: break-word; word-break: break-word; }
.mc-text {
  margin: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 0.95em);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
img { max-width: 100%; height: auto; }
/* Reader chrome, not mail styling: full specificity so a newsletter cannot hide the marker that
   says an image was blocked. */
img[data-mc-remote] {
  outline: 1px dashed #b0b0b0;
  outline-offset: -1px;
  max-height: 40vh;
  color: #6a6a6a;
  font-size: 0.85em;
}
:is(input, select, textarea, button) { pointer-events: none; }
`.trim();

const KILOBYTE = 1024;
const TEXT_MAX = 4 * 1024 * 1024;
const TRUNCATED = "\n\n(the rest of this message is too long to show; open the plaintext reader)";

/** The same ranges `src/model/messageFormat.ts` strips, and for the same reason: a bidi override
 * in a body would otherwise rewrite the line around it, including an autolinked URL. Tab, newline
 * and carriage return stay — a body keeps its shape. */
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

const NEWLINES = /\r\n?/g;

export interface HostBridge {
  post(message: WebviewToHostMessage): void;
}

export interface Reader {
  render(message: RenderMessage): void;
  status(text: string): void;
}

interface Chrome {
  readonly toolbar: Element;
  readonly banner: Element;
  readonly header: Element;
  readonly attachments: Element;
  readonly body: Element;
}

/** The shell (`src/reader/shell.ts`) ships these five containers. One is created here only so a
 * test can drive the reader against a bare document. */
function container(document: Document, id: string): Element {
  const existing = document.getElementById(id);
  if (existing !== null) {
    return existing;
  }
  const created = document.createElement("div");
  created.id = id;
  document.body.append(created);
  return created;
}

function element(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

function button(document: Document, className: string, label: string): HTMLButtonElement {
  const created = document.createElement("button");
  created.type = "button";
  created.className = className;
  created.textContent = label;
  return created;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "?";
  }
  if (bytes < KILOBYTE) {
    return `${String(Math.round(bytes))} B`;
  }
  if (bytes < KILOBYTE * KILOBYTE) {
    return `${decimal(bytes / KILOBYTE)} KB`;
  }
  return `${decimal(bytes / (KILOBYTE * KILOBYTE))} MB`;
}

function decimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function isStripped(point: number): boolean {
  for (const [low, high] of STRIPPED) {
    if (point >= low && point <= high) {
      return true;
    }
  }
  return false;
}

export function visibleText(value: string): string {
  const truncated = value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX)}${TRUNCATED}` : value;
  const kept: string[] = [];
  for (const character of truncated.replace(NEWLINES, "\n")) {
    if (!isStripped(character.codePointAt(0) ?? 0)) {
      kept.push(character);
    }
  }
  return kept.join("");
}

export function blockedImagesLabel(count: number): string {
  return count === 1 ? "1 remote image blocked" : `${String(count)} remote images blocked`;
}

/** Walks up by `parentNode` rather than `instanceof`: the node may have been minted in the
 * sanitiser's document, and an `instanceof` check across realms answers false. */
function closestAnchor(start: EventTarget | null): Element | undefined {
  let node = start as Node | null;
  while (node !== null) {
    if (node.nodeType === ELEMENT_NODE && (node as Element).localName === ANCHOR) {
      return node as Element;
    }
    node = node.parentNode;
  }
  return undefined;
}

/** `https://` only, matched strictly, and rebuilt with DOM calls. Text mode never sees `innerHTML`
 * and never linkifies a scheme the host would refuse to open. */
export function autolink(document: Document, text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const match of text.matchAll(HTTPS_IN_TEXT)) {
    const start = match.index;
    const raw = match[0];
    const href = raw.replace(TRAILING_PUNCTUATION, "");
    if (href === "" || !isResolvableHttps(href)) {
      continue;
    }
    if (start > cursor) {
      fragment.append(document.createTextNode(text.slice(cursor, start)));
    }
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = href;
    fragment.append(anchor);
    cursor = start + href.length;
  }

  if (cursor < text.length) {
    fragment.append(document.createTextNode(text.slice(cursor)));
  }
  return fragment;
}

function isResolvableHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function createReader(document: Document, sanitizer: BodySanitizer, bridge: HostBridge): Reader {
  const chrome: Chrome = {
    toolbar: container(document, ShellElementIds.Toolbar),
    banner: container(document, ShellElementIds.Banner),
    header: container(document, ShellElementIds.Header),
    attachments: container(document, ShellElementIds.Attachments),
    body: container(document, ShellElementIds.Body),
  };

  const statusLine = element(document, "div", "mc-status");
  statusLine.hidden = true;
  chrome.toolbar.after(statusLine);

  // Mail CSS is scoped to this tree; a rule in it cannot select the toolbar, the banner or the header.
  const mailRoot = chrome.body.shadowRoot ?? chrome.body.attachShadow({ mode: "open" });

  function mount(...content: Node[]): void {
    const style = document.createElement("style");
    style.textContent = MAIL_STYLES;
    const wrapper = element(document, "div", MAIL_WRAPPER);
    wrapper.append(...content);
    mailRoot.replaceChildren(style, wrapper);
  }

  document.body.addEventListener("click", (event: Event) => {
    const anchor = closestAnchor(event.composedPath()[0] ?? event.target);
    if (anchor === undefined) {
      return;
    }
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (href === null || !SAFE_LINK.test(href)) {
      return;
    }
    bridge.post({ type: "openLink", href });
  });

  function toolbar(message: RenderMessage): void {
    const html = button(document, "mc-mode", VIEW_HTML);
    const text = button(document, "mc-mode", VIEW_TEXT);
    const active = message.mode === "html" ? html : text;
    active.setAttribute("aria-pressed", "true");
    active.classList.add("mc-mode--active");
    active.disabled = true;
    html.addEventListener("click", () => {
      bridge.post({ type: "viewHtml" });
    });
    text.addEventListener("click", () => {
      bridge.post({ type: "viewText" });
    });
    chrome.toolbar.replaceChildren(html, text);
  }

  function banner(message: RenderMessage, blocked: number): void {
    if (blocked > 0) {
      const bar = element(document, "div", "mc-blocked");
      bar.append(element(document, "span", "mc-blocked__count", blockedImagesLabel(blocked)));
      const allow = button(document, "mc-blocked__allow", LOAD_IMAGES);
      allow.addEventListener("click", () => {
        bridge.post({ type: "allowRemote", messageId: message.messageId });
      });
      bar.append(allow);
      chrome.banner.replaceChildren(bar);
      return;
    }
    if (message.mode === "html" && message.allowedOrigins.length > 0) {
      chrome.banner.replaceChildren(element(document, "div", "mc-blocked mc-blocked--allowed", IMAGES_LOADED));
      return;
    }
    chrome.banner.replaceChildren();
  }

  function field(label: string, value: string): HTMLElement {
    const row = element(document, "div", "mc-field");
    row.append(element(document, "span", "mc-field__label", label));
    row.append(element(document, "span", "mc-field__value", value));
    return row;
  }

  function header(message: RenderMessage): void {
    const head = message.header;
    const rows: HTMLElement[] = [
      element(document, "h1", "mc-subject", head.subject === "" ? NO_SUBJECT : head.subject),
      field("From", head.from === "" ? NO_SENDER : head.from),
      field("To", head.to === "" ? NO_RECIPIENT : head.to),
    ];
    if (head.cc !== undefined && head.cc !== "") {
      rows.push(field("Cc", head.cc));
    }
    rows.push(field("Date", head.date));

    if (head.tags.length > 0) {
      const row = element(document, "div", "mc-field");
      row.append(element(document, "span", "mc-field__label", "Tags"));
      const list = element(document, "span", "mc-field__value mc-tags");
      for (const tag of head.tags) {
        list.append(element(document, "span", "mc-tag", tag));
      }
      row.append(list);
      rows.push(row);
    }
    chrome.header.replaceChildren(...rows);
  }

  function attachmentRow(attachment: RenderAttachment): HTMLElement {
    const row = element(document, "div", "mc-attachment");
    row.append(element(document, "span", "mc-attachment__icon", "\u{1f4c4}"));
    row.append(
      element(
        document,
        "span",
        "mc-attachment__name",
        attachment.filename === "" ? NO_FILENAME : attachment.filename,
      ),
    );
    row.append(element(document, "span", "mc-attachment__mime", attachment.mime));
    row.append(element(document, "span", "mc-attachment__size", formatSize(attachment.size)));
    const save = button(document, "mc-attachment__save", SAVE);
    save.addEventListener("click", () => {
      bridge.post({ type: "saveAttachment", index: attachment.index });
    });
    row.append(save);
    return row;
  }

  function attachments(message: RenderMessage): void {
    chrome.attachments.replaceChildren(...message.attachments.map(attachmentRow));
  }

  function textBody(message: RenderMessage): void {
    const pre = element(document, "pre", "mc-text");
    const text = visibleText(message.bodyText ?? "");
    if (text.trim() === "") {
      pre.textContent = NO_BODY;
    } else {
      pre.append(autolink(document, text));
    }
    chrome.body.className = "mc-body mc-body--text";
    mount(pre);
  }

  return {
    render(message: RenderMessage): void {
      statusLine.textContent = "";
      statusLine.hidden = true;
      header(message);
      attachments(message);
      toolbar(message);

      if (message.mode === "text") {
        textBody(message);
        banner(message, 0);
        return;
      }

      const sanitized = sanitizer.sanitize(message.bodyHtml ?? "", {
        inlineImages: message.inlineImages,
        allowedOrigins: message.allowedOrigins,
      });
      chrome.body.className = "mc-body mc-body--html";
      mount(sanitized.fragment);
      banner(message, sanitized.census.blocked);

      if (sanitized.census.blocked > 0) {
        bridge.post({
          type: "blockedImages",
          messageId: message.messageId,
          count: sanitized.census.blocked,
          origins: [...sanitized.census.origins],
        });
      }
    },
    status(text: string): void {
      statusLine.textContent = text;
      statusLine.hidden = text === "";
    },
  };
}
