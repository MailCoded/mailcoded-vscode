export const MAX_IMAGE_ORIGINS = 32;

export const ShellElementIds = {
  Toolbar: "mc-toolbar",
  Banner: "mc-banner",
  Header: "mc-header",
  Attachments: "mc-attachments",
  Body: "mc-body",
} as const;

export type RenderMode = "html" | "text";

export interface RenderHeader {
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly cc?: string;
  readonly date: string;
  readonly tags: readonly string[];
}

export interface RenderAttachment {
  readonly index: number;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
}

export interface RenderMessage {
  readonly type: "render";
  readonly messageId: number;
  readonly mode: RenderMode;
  readonly header: RenderHeader;
  readonly bodyHtml?: string;
  readonly bodyText?: string;
  readonly attachments: readonly RenderAttachment[];
  readonly inlineImages: Readonly<Record<string, string>>;
  readonly allowedOrigins: readonly string[];
}

export interface StatusMessage {
  readonly type: "status";
  readonly text: string;
}

export type HostToWebviewMessage = RenderMessage | StatusMessage;

export interface ReadyMessage {
  readonly type: "ready";
}

export interface BlockedImagesMessage {
  readonly type: "blockedImages";
  readonly messageId: number;
  readonly count: number;
  readonly origins: readonly string[];
}

export interface AllowRemoteMessage {
  readonly type: "allowRemote";
  readonly messageId: number;
}

export interface OpenLinkMessage {
  readonly type: "openLink";
  readonly href: string;
}

export interface SaveAttachmentMessage {
  readonly type: "saveAttachment";
  readonly index: number;
}

export interface ViewTextMessage {
  readonly type: "viewText";
}

export interface ViewHtmlMessage {
  readonly type: "viewHtml";
}

export interface CspViolationMessage {
  readonly type: "cspViolation";
  readonly directive: string;
  readonly blockedOrigin: string;
}

export interface RenderedMessage {
  readonly type: "rendered";
  readonly messageId: number;
  readonly elapsedMs: number;
}

export type WebviewToHostMessage =
  | ReadyMessage
  | BlockedImagesMessage
  | AllowRemoteMessage
  | OpenLinkMessage
  | SaveAttachmentMessage
  | ViewTextMessage
  | ViewHtmlMessage
  | CspViolationMessage
  | RenderedMessage;

const HEADER_MAX = 998;
const TAG_MAX = 100;
const TAGS_MAX = 64;
const DATE_MAX = 64;
const STATUS_MAX = 400;
const HREF_MAX = 4096;
const MIME_MAX = 129;
const CID_MAX = 998;
const DATA_URL_MAX = 8 * 1024 * 1024;
const ATTACHMENTS_MAX = 256;
const INLINE_IMAGES_MAX = 256;
const INDEX_MAX = 10_000;
const COUNT_MAX = 1_000_000;
const ELAPSED_MAX = 3_600_000;
const ORIGIN_MAX = 256;
const DIRECTIVE_MAX = 64;
const TYPE_MAX = 32;

const CONTROL = /\p{Cc}/u;
const IMAGE_ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;
const SAFE_HREF = /^(?:https:\/\/|mailto:)\S+$/i;
const CID_KEY = /^[!-~]+$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|x-icon);base64,[A-Za-z0-9+/]*={0,2}$/i;
const CSP_DIRECTIVE = /^[a-z][a-z0-9-]{0,63}$/;
const REPORT_ORIGIN = /^(?:[a-z][a-z0-9+.-]{0,31}:(?:\/\/[a-z0-9._:-]{0,253})?|inline|eval|self|data|blob)$/i;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

const NO_TYPE = "(no type)";
const UNPRINTABLE_TYPE = "(unprintable type)";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !CONTROL.test(value);
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isElapsed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= ELAPSED_MAX;
}

export function isImageOrigin(value: unknown): value is string {
  return typeof value === "string" && value.length <= ORIGIN_MAX && IMAGE_ORIGIN.test(value);
}

/** The host hands this straight to `vscode.env.openExternal`, so the scheme allowlist is enforced
 * on the frame: a webview that has been taken over still cannot name `file:` or `command:`. */
export function isSafeHref(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= HREF_MAX && !CONTROL.test(value) && SAFE_HREF.test(value)
  );
}

export function toOrigin(href: string): string {
  const match = /^([a-z][a-z0-9+.-]{0,31}:)(?:\/\/([a-z0-9._:-]{0,253}))?/i.exec(href);
  if (match === null) {
    return "";
  }
  const scheme = match[1] ?? "";
  const host = match[2];
  const origin = host === undefined ? scheme : `${scheme}//${host}`;
  return REPORT_ORIGIN.test(origin) ? origin : "";
}

/** Log-safe: a rejected frame's own `type` may be attacker text, and the caller logs it. */
export function messageTypeOf(value: unknown): string {
  if (!isRecord(value)) {
    return NO_TYPE;
  }
  const type = value["type"];
  if (typeof type !== "string" || type.length > TYPE_MAX) {
    return NO_TYPE;
  }
  return TYPE_NAME.test(type) ? type : UNPRINTABLE_TYPE;
}

function stringList(value: unknown, max: number, each: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > max) {
    return undefined;
  }
  const kept: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (!isText(entry, each)) {
      return undefined;
    }
    kept.push(entry);
  }
  return kept;
}

function header(value: unknown): RenderHeader | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const subject = value["subject"];
  const from = value["from"];
  const to = value["to"];
  const cc = value["cc"];
  const date = value["date"];
  const tags = stringList(value["tags"], TAGS_MAX, TAG_MAX);

  if (!isText(subject, HEADER_MAX) || !isText(from, HEADER_MAX) || !isText(to, HEADER_MAX)) {
    return undefined;
  }
  if (!isText(date, DATE_MAX) || tags === undefined) {
    return undefined;
  }
  if (cc !== undefined && !isText(cc, HEADER_MAX)) {
    return undefined;
  }

  return { subject, from, to, date, tags, ...(cc === undefined ? {} : { cc }) };
}

function attachments(value: unknown): readonly RenderAttachment[] | undefined {
  if (!Array.isArray(value) || value.length > ATTACHMENTS_MAX) {
    return undefined;
  }
  const kept: RenderAttachment[] = [];
  for (const entry of value as readonly unknown[]) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const index = entry["index"];
    const filename = entry["filename"];
    const mime = entry["mime"];
    const size = entry["size"];
    if (!isCount(index, INDEX_MAX) || !isCount(size, Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    if (!isText(filename, HEADER_MAX) || !isText(mime, MIME_MAX) || !MIME.test(mime)) {
      return undefined;
    }
    kept.push({ index, filename, mime, size });
  }
  return kept;
}

/** Keys are `cid:` references from mail, so one malformed entry is dropped rather than failing the
 * whole render, and the map is prototype-less: an attacker-chosen `__proto__` key is then inert. */
function inlineImages(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > INLINE_IMAGES_MAX) {
    return undefined;
  }
  const kept = Object.create(null) as Record<string, string>;
  for (const [key, source] of entries) {
    if (key.length > CID_MAX || !CID_KEY.test(key)) {
      continue;
    }
    if (typeof source !== "string" || source.length > DATA_URL_MAX || !DATA_IMAGE.test(source)) {
      continue;
    }
    kept[key] = source;
  }
  return kept;
}

function origins(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ORIGINS) {
    return undefined;
  }
  const kept: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (!isImageOrigin(entry)) {
      return undefined;
    }
    kept.push(entry);
  }
  return kept;
}

function render(value: Readonly<Record<string, unknown>>): RenderMessage | undefined {
  const messageId = value["messageId"];
  const mode = value["mode"];
  const bodyHtml = value["bodyHtml"];
  const bodyText = value["bodyText"];
  const parsed = header(value["header"]);
  const files = attachments(value["attachments"]);
  const images = inlineImages(value["inlineImages"]);
  const allowedOrigins = origins(value["allowedOrigins"]);

  if (!isCount(messageId, Number.MAX_SAFE_INTEGER) || (mode !== "html" && mode !== "text")) {
    return undefined;
  }
  if (parsed === undefined || files === undefined || images === undefined || allowedOrigins === undefined) {
    return undefined;
  }
  if (bodyHtml !== undefined && typeof bodyHtml !== "string") {
    return undefined;
  }
  if (bodyText !== undefined && typeof bodyText !== "string") {
    return undefined;
  }

  return {
    type: "render",
    messageId,
    mode,
    header: parsed,
    attachments: files,
    inlineImages: images,
    allowedOrigins,
    ...(bodyHtml === undefined ? {} : { bodyHtml }),
    ...(bodyText === undefined ? {} : { bodyText }),
  };
}

/** The webview's inbound gate. The result is rebuilt from validated fields, so a frame cannot
 * smuggle a key past the contract, and an unknown `type` is dropped rather than dispatched. */
export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value["type"]) {
    case "render":
      return render(value);
    case "status": {
      const text = value["text"];
      return isText(text, STATUS_MAX) ? { type: "status", text } : undefined;
    }
    default:
      return undefined;
  }
}

/** The extension host's inbound gate. Everything the host acts on — a link it opens, an
 * attachment index it saves, an origin it adds to the image policy — is validated here. */
export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const messageId = value["messageId"];
  switch (value["type"]) {
    case "ready":
      return { type: "ready" };
    case "viewText":
      return { type: "viewText" };
    case "viewHtml":
      return { type: "viewHtml" };
    case "blockedImages": {
      const count = value["count"];
      const seen = origins(value["origins"]);
      if (!isCount(messageId, Number.MAX_SAFE_INTEGER) || !isCount(count, COUNT_MAX)) {
        return undefined;
      }
      return seen === undefined ? undefined : { type: "blockedImages", messageId, count, origins: seen };
    }
    case "allowRemote":
      return isCount(messageId, Number.MAX_SAFE_INTEGER) ? { type: "allowRemote", messageId } : undefined;
    case "openLink": {
      const href = value["href"];
      return isSafeHref(href) ? { type: "openLink", href } : undefined;
    }
    case "saveAttachment": {
      const index = value["index"];
      return isCount(index, INDEX_MAX) ? { type: "saveAttachment", index } : undefined;
    }
    case "cspViolation": {
      const directive = value["directive"];
      const blockedOrigin = value["blockedOrigin"];
      if (!isText(directive, DIRECTIVE_MAX) || !CSP_DIRECTIVE.test(directive)) {
        return undefined;
      }
      if (!isText(blockedOrigin, ORIGIN_MAX) || !(blockedOrigin === "" || REPORT_ORIGIN.test(blockedOrigin))) {
        return undefined;
      }
      return { type: "cspViolation", directive, blockedOrigin };
    }
    case "rendered": {
      const elapsedMs = value["elapsedMs"];
      if (!isCount(messageId, Number.MAX_SAFE_INTEGER) || !isElapsed(elapsedMs)) {
        return undefined;
      }
      return { type: "rendered", messageId, elapsedMs };
    }
    default:
      return undefined;
  }
}
