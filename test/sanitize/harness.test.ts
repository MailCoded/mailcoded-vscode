import { JSDOM } from "jsdom";
import type { DOMWindow } from "jsdom";

import type { RenderMessage, WebviewToHostMessage } from "../../src/reader/protocol.js";
import { createReader } from "../../src/webview/render.js";
import type { Reader } from "../../src/webview/render.js";
import { createSanitizer } from "../../src/webview/sanitize.js";
import type { BodySanitizer, RemoteImageCensus, SanitizeRequest } from "../../src/webview/sanitize.js";

/** Mirrors the five containers `src/reader/shell.ts` writes, so the reader is exercised against
 * the document it will actually meet. */
const SHELL = [
  "<!doctype html><html><head></head><body>",
  '<div id="mc-toolbar"></div>',
  '<div id="mc-banner" role="status"></div>',
  '<div id="mc-header"></div>',
  '<div id="mc-attachments"></div>',
  '<div id="mc-body"></div>',
  "</body></html>",
].join("");

export interface Harness {
  readonly window: DOMWindow;
  readonly document: Document;
  readonly sanitizer: BodySanitizer;
}

export function harness(html = SHELL): Harness {
  const dom = new JSDOM(html, { url: "https://webview.invalid/" });
  const window = dom.window;
  return {
    window,
    document: window.document,
    sanitizer: createSanitizer(window),
  };
}

export interface Cleaned {
  readonly element: HTMLElement;
  readonly html: string;
  readonly census: RemoteImageCensus;
  readonly window: DOMWindow;
}

export function clean(dirty: string, request?: SanitizeRequest): Cleaned {
  const context = harness();
  const result = context.sanitizer.sanitize(dirty, request);
  const element = context.document.createElement("div");
  element.append(result.fragment);
  return { element, html: element.innerHTML, census: result.census, window: context.window };
}

export function tagsIn(element: Element): readonly string[] {
  return [...element.querySelectorAll("*")].map((child) => child.localName.toLowerCase());
}

export function attributeNames(element: Element): readonly string[] {
  const names: string[] = [];
  for (const child of element.querySelectorAll("*")) {
    for (const attribute of child.attributes) {
      names.push(attribute.name.toLowerCase());
    }
  }
  return names;
}

export function attributeValues(element: Element): readonly string[] {
  const values: string[] = [];
  for (const child of element.querySelectorAll("*")) {
    for (const attribute of child.attributes) {
      values.push(attribute.value);
    }
  }
  return values;
}

export interface Wired {
  readonly window: DOMWindow;
  readonly document: Document;
  readonly reader: Reader;
  readonly posted: WebviewToHostMessage[];
}

export function wire(): Wired {
  const context = harness();
  const posted: WebviewToHostMessage[] = [];
  const reader = createReader(context.document, context.sanitizer, {
    post(message: WebviewToHostMessage): void {
      posted.push(message);
    },
  });
  return { window: context.window, document: context.document, reader, posted };
}

export function click(window: DOMWindow, target: Element): boolean {
  return target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
}

export interface FrameOptions {
  readonly mode?: "html" | "text";
  readonly bodyHtml?: string;
  readonly bodyText?: string;
  readonly attachments?: RenderMessage["attachments"];
  readonly inlineImages?: Readonly<Record<string, string>>;
  readonly allowedOrigins?: readonly string[];
  readonly cc?: string;
  readonly tags?: readonly string[];
}

export function frame(options: FrameOptions = {}): RenderMessage {
  return {
    type: "render",
    messageId: 4213,
    mode: options.mode ?? "html",
    header: {
      subject: "Quarterly report",
      from: "Ada <ada@example.com>",
      to: "me@example.com",
      date: "2026-08-30 12:34",
      tags: options.tags ?? [],
      ...(options.cc === undefined ? {} : { cc: options.cc }),
    },
    attachments: options.attachments ?? [],
    inlineImages: options.inlineImages ?? {},
    allowedOrigins: options.allowedOrigins ?? [],
    ...(options.bodyHtml === undefined ? {} : { bodyHtml: options.bodyHtml }),
    ...(options.bodyText === undefined ? {} : { bodyText: options.bodyText }),
  };
}

/** Mocha loads every file matching the spec, so this one needs a test of its own to stay honest. */
describe("the sanitize harness", () => {
  it("builds a document with the shell's five containers", () => {
    const context = harness();
    for (const id of ["mc-toolbar", "mc-banner", "mc-header", "mc-attachments", "mc-body"]) {
      if (context.document.getElementById(id) === null) {
        throw new Error(`the harness document is missing #${id}`);
      }
    }
  });
});
