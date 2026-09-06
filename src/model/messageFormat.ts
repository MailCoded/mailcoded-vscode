import type { AttachmentDto, EnvelopeDto, MessageGetResult } from "../protocol/index.js";

/** C0 and C1 controls, the zero-width and bidi overrides, and the tag block, as in
 * `src/views/treeItems.ts`. Tab, newline and carriage return are absent on purpose: a line
 * collapses them and a body keeps them. */
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
const NEWLINES = /\r\n?/g;
const ELLIPSIS = "…";
const LINE_MAX = 200;
const HEADER_MAX = 998;
const LABEL_WIDTH = 9;

const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const UNKNOWN_DATE = "??? ??";
const NO_SUBJECT = "(no subject)";
const NO_SENDER = "(unknown sender)";
const NO_RECIPIENT = "(none)";
const NO_FILENAME = "(unnamed)";
const NOT_FETCHED = "(body not fetched)";
const NO_PLAINTEXT = "(this message has no plaintext part)";

const ADDRESS = /^(.*)<([^<>]*)>[^<>]*$/;
const QUOTED = /^"(.*)"$/;

function isStripped(point: number): boolean {
  for (const [low, high] of STRIPPED) {
    if (point >= low && point <= high) {
      return true;
    }
  }
  return false;
}

function strip(text: string): string {
  const kept: string[] = [];
  for (const character of text) {
    if (!isStripped(character.codePointAt(0) ?? 0)) {
      kept.push(character);
    }
  }
  return kept.join("");
}

/** Subjects, addresses and filenames are attacker input: a bidi override or a tag-block sequence
 * would otherwise rewrite the line around it. */
export function hardenLine(value: string | undefined, max: number = LINE_MAX): string {
  // An optional DTO field arrives as `null` on the wire (rpc.md §7), not as an absent key.
  if (typeof value !== "string") {
    return "";
  }

  const collapsed = strip(value).replace(WHITESPACE, " ").trim();
  const points = Array.from(collapsed);
  if (max <= 0 || points.length <= max) {
    return collapsed;
  }
  return `${points.slice(0, max - 1).join("")}${ELLIPSIS}`;
}

export function senderLabel(envelope: EnvelopeDto): string {
  const from = hardenLine(envelope.from);
  if (from === "") {
    return NO_SENDER;
  }

  const parts = ADDRESS.exec(from);
  if (parts === null) {
    return from;
  }

  const named = (parts[1] ?? "").trim();
  const unquoted = QUOTED.exec(named);
  const display = (unquoted === null ? named : (unquoted[1] ?? "")).trim();
  if (display !== "") {
    return display;
  }

  const address = (parts[2] ?? "").trim();
  return address === "" ? NO_SENDER : address;
}

export function shortDate(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return UNKNOWN_DATE;
  }

  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  return sameDay
    ? `${pad(at.getHours())}:${pad(at.getMinutes())}`
    : `${MONTHS[at.getMonth()] ?? "???"} ${pad(at.getDate())}`;
}

export function messageDocument(message: MessageGetResult): string {
  const envelope = message.envelope;
  const lines: string[] = [
    field("Subject", header(envelope.subject) || NO_SUBJECT),
    field("From", header(envelope.from) || NO_SENDER),
    field("To", header(envelope.to) || NO_RECIPIENT),
  ];

  const cc = header(envelope.cc);
  if (cc !== "") {
    lines.push(field("Cc", cc));
  }

  lines.push(field("Date", longDate(envelope.date)));

  if (envelope.tags.length > 0) {
    lines.push(field("Tags", header(envelope.tags.join(" "))));
  }

  for (const attachment of message.attachments) {
    lines.push(field("Attach", attachmentLine(attachment)));
  }

  if (message.parseWarnings.length > 0) {
    lines.push(field("Warn", header(message.parseWarnings.join(" "))));
  }

  return `${lines.join("\n")}\n\n${body(message)}\n`;
}

function body(message: MessageGetResult): string {
  const text = message.bodyText ?? "";
  if (text.trim() === "") {
    return message.bodyFetched ? NO_PLAINTEXT : NOT_FETCHED;
  }
  return strip(text).replace(NEWLINES, "\n").trimEnd();
}

function attachmentLine(attachment: AttachmentDto): string {
  const filename = header(attachment.filename) || NO_FILENAME;
  return `${String(attachment.index)}  ${filename}  ${header(attachment.mime)}  ${size(attachment.size)}`;
}

function field(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function header(value: string | undefined): string {
  return hardenLine(value, HEADER_MAX);
}

function longDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return hardenLine(iso, 40);
  }

  const day = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function size(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${decimal(bytes / 1024)} KB`;
  }
  return `${decimal(bytes / (1024 * 1024))} MB`;
}

function decimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
