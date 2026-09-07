import { randomBytes } from "node:crypto";

import { MAX_IMAGE_ORIGINS, ShellElementIds, isImageOrigin } from "./protocol.js";

const NONCE_BYTES = 16;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const CSP_SOURCE = /^[A-Za-z0-9:/*._-]{1,256}$/;
const SCRIPT_URI =
  /^(?:https|vscode-webview|vscode-webview-resource|vscode-resource|vscode-file):\/\/[A-Za-z0-9._~:/?#@!$()*+,;=%[\]-]{1,2048}$/;
const STYLE_BREAKOUT = /<\/|<!--/;

export interface ShellOptions {
  readonly nonce: string;
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styles: string;
  readonly allowedOrigins?: readonly string[];
}

/** The frame only. The mail itself is styled by the webview bundle's own stylesheet, which arrives
 * with the script; this is what keeps the document from painting unstyled before that runs. */
export const READER_STYLES = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#${ShellElementIds.Toolbar},
#${ShellElementIds.Banner},
#${ShellElementIds.Header},
#${ShellElementIds.Attachments} {
  padding: 0.35rem 0.9rem;
}
#${ShellElementIds.Body} {
  padding: 0.9rem;
  overflow-wrap: anywhere;
}
#${ShellElementIds.Toolbar}:empty,
#${ShellElementIds.Banner}:empty,
#${ShellElementIds.Header}:empty,
#${ShellElementIds.Attachments}:empty {
  display: none;
}
`.trim();

export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

/** SPEC 6.3, byte for byte. The per-message image allow is the only permitted variation, and it
 * may only ever append validated `https://host[:port]` origins to the image policy. */
export function buildCsp(nonce: string, cspSource: string, allowedOrigins: readonly string[]): string {
  if (!NONCE.test(nonce)) {
    throw new Error("The CSP nonce must be base64url and at least 128 bits wide.");
  }
  if (!CSP_SOURCE.test(cspSource)) {
    throw new Error("The webview CSP source is not a bare source expression.");
  }
  return (
    `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}'; img-src ${imageSources(allowedOrigins)};`
  );
}

/** The only HTML string in the repository, and it carries no mail: the reader's content arrives by
 * `postMessage` and is written into these containers by the webview, after DOMPurify. */
export function buildShell(options: ShellOptions): string {
  const csp = buildCsp(options.nonce, options.cspSource, options.allowedOrigins ?? []);
  if (!SCRIPT_URI.test(options.scriptUri)) {
    throw new Error("The webview script URI is not a quote-free absolute URI of a known scheme.");
  }
  if (STYLE_BREAKOUT.test(options.styles)) {
    throw new Error("The stylesheet may not contain a markup-closing sequence.");
  }

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <style>",
    options.styles,
    "    </style>",
    "  </head>",
    "  <body>",
    `    <div id="${ShellElementIds.Toolbar}"></div>`,
    `    <div id="${ShellElementIds.Banner}" role="status"></div>`,
    `    <div id="${ShellElementIds.Header}"></div>`,
    `    <div id="${ShellElementIds.Attachments}"></div>`,
    `    <div id="${ShellElementIds.Body}"></div>`,
    `    <script nonce="${options.nonce}" src="${options.scriptUri}"></script>`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

function imageSources(allowedOrigins: readonly string[]): string {
  if (allowedOrigins.length > MAX_IMAGE_ORIGINS) {
    throw new Error(`At most ${String(MAX_IMAGE_ORIGINS)} image origins may be allowed for one render.`);
  }
  const distinct = new Set<string>();
  for (const origin of allowedOrigins) {
    if (!isImageOrigin(origin)) {
      throw new Error("An allowed image origin must be exactly https://host or https://host:port.");
    }
    distinct.add(origin.toLowerCase());
  }
  return distinct.size === 0 ? "data:" : `data: ${[...distinct].join(" ")}`;
}
