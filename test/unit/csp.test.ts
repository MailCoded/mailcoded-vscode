import assert from "node:assert/strict";

import {
  messageTypeOf,
  parseHostMessage,
  parseWebviewMessage,
  toOrigin,
} from "../../src/reader/protocol.js";
import { buildCsp, buildShell, createNonce } from "../../src/reader/shell.js";

const NONCE = "NONCESENTINELnoncesentinel0";
const CSP_SOURCE = "vscode-webview://cspsourcesentinel";
const SCRIPT_URI = "vscode-webview-resource://scriptsentinel/main.js";
const STYLES = ".mc-stylesentinel{color:red}";

const SPEC_CSP =
  "default-src 'none'; style-src vscode-webview://cspsourcesentinel 'unsafe-inline'; " +
  "script-src 'nonce-NONCESENTINELnoncesentinel0'; img-src data:;";

const IMAGE_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const SCHEME_SOURCE_HTTPS = /(?:^|[\s"';])https:(?:[\s"';]|$)/;
const SCRIPT_TAG = /<script\b/gi;

const REJECTED_ORIGINS: readonly (readonly [string, string])[] = [
  ["plain http", "http://cdn.example.com"],
  ["the bare https scheme", "https:"],
  ["a scheme wildcard", "https://*"],
  ["a host wildcard", "https://*.example.com"],
  ["a lone wildcard", "*"],
  ["a data URL", "data:image/png;base64,AAAA"],
  ["a path", "https://cdn.example.com/pixel.gif"],
  ["a trailing slash", "https://cdn.example.com/"],
  ["credentials", "https://user:pass@cdn.example.com"],
  ["a space", "https://cdn.example.com evil.example.com"],
  ["a directive terminator", "https://cdn.example.com; script-src *"],
  ["a quote", "https://cdn.example.com' 'unsafe-eval"],
  ["a newline", "https://cdn.example.com\nimg-src *"],
  ["an over-long port", "https://cdn.example.com:123456"],
  ["the empty string", ""],
  ["a protocol-relative host", "//cdn.example.com"],
];

function directive(csp: string, name: string): readonly string[] {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .find((part) => part === name || part.startsWith(`${name} `));
  assert.ok(found !== undefined, `the CSP has no ${name} directive`);
  return found.split(" ").slice(1);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function origins(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `https://cdn${String(index)}.example.com`);
}

function shell(): string {
  return buildShell({ nonce: NONCE, cspSource: CSP_SOURCE, scriptUri: SCRIPT_URI, styles: STYLES });
}

describe("buildCsp", () => {
  it("is the SPEC 6.3 string byte for byte when nothing is allowed", () => {
    assert.equal(buildCsp(NONCE, CSP_SOURCE, []), SPEC_CSP);
  });

  it("names no remote origin, no wildcard and no unsafe script source by default", () => {
    const csp = buildCsp(NONCE, CSP_SOURCE, []);
    assert.equal(SCHEME_SOURCE_HTTPS.test(csp), false);
    assert.equal(csp.includes("*"), false);
    assert.equal(csp.includes("unsafe-eval"), false);
    assert.deepEqual(directive(csp, "script-src"), [`'nonce-${NONCE}'`]);
    assert.deepEqual(directive(csp, "default-src"), ["'none'"]);
    assert.deepEqual(directive(csp, "img-src"), ["data:"]);
  });

  it("changes only img-src when a render allows origins", () => {
    const allowed = ["https://cdn.example.com", "https://images.example.org:8443"];
    const csp = buildCsp(NONCE, CSP_SOURCE, allowed);

    assert.equal(
      csp,
      "default-src 'none'; style-src vscode-webview://cspsourcesentinel 'unsafe-inline'; " +
        "script-src 'nonce-NONCESENTINELnoncesentinel0'; " +
        "img-src data: https://cdn.example.com https://images.example.org:8443;",
    );

    const before = SPEC_CSP.split(";").map((part) => part.trim());
    const after = csp.split(";").map((part) => part.trim());
    assert.equal(after.length, before.length);
    for (const [index, part] of after.entries()) {
      if (part.startsWith("img-src")) {
        continue;
      }
      assert.equal(part, before[index]);
    }

    const sources = directive(csp, "img-src");
    assert.equal(sources[0], "data:");
    for (const source of sources.slice(1)) {
      assert.match(source, IMAGE_ORIGIN);
    }
    assert.deepEqual(sources.slice(1), allowed);
  });

  it("lower-cases and de-duplicates the allowed origins", () => {
    const csp = buildCsp(NONCE, CSP_SOURCE, [
      "https://CDN.Example.COM",
      "https://cdn.example.com",
      "https://other.example.com",
    ]);
    assert.deepEqual(directive(csp, "img-src"), [
      "data:",
      "https://cdn.example.com",
      "https://other.example.com",
    ]);
  });

  it("accepts exactly 32 origins and refuses 33 rather than truncating", () => {
    assert.equal(directive(buildCsp(NONCE, CSP_SOURCE, origins(32)), "img-src").length, 33);
    assert.throws(() => buildCsp(NONCE, CSP_SOURCE, origins(33)), /32 image origins/);
  });

  for (const [what, origin] of REJECTED_ORIGINS) {
    it(`refuses an image origin with ${what}`, () => {
      assert.equal(IMAGE_ORIGIN.test(origin), false);
      assert.throws(() => buildCsp(NONCE, CSP_SOURCE, [origin]), /allowed image origin/);
    });
  }

  it("refuses a nonce that is too short or not base64url", () => {
    assert.throws(() => buildCsp("short", CSP_SOURCE, []), /nonce/);
    assert.throws(() => buildCsp(`${NONCE}' 'unsafe-inline`, CSP_SOURCE, []), /nonce/);
    assert.throws(() => buildCsp(`${NONCE}; img-src *`, CSP_SOURCE, []), /nonce/);
  });

  it("refuses a webview source that could close the directive", () => {
    assert.throws(() => buildCsp(NONCE, "vscode-webview://x; script-src *", []), /CSP source/);
    assert.throws(() => buildCsp(NONCE, "vscode-webview://x' 'unsafe-eval", []), /CSP source/);
    assert.throws(() => buildCsp(NONCE, "", []), /CSP source/);
  });
});

describe("createNonce", () => {
  it("is at least 128 bits of base64url", () => {
    const nonce = createNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
    assert.ok(nonce.length >= 22, `a 128-bit base64url nonce is 22 characters, got ${String(nonce.length)}`);
    assert.ok(Buffer.from(nonce, "base64url").length >= 16);
  });

  it("differs between two calls", () => {
    assert.notEqual(createNonce(), createNonce());
  });

  it("produces a nonce the CSP accepts", () => {
    const nonce = createNonce();
    assert.ok(buildCsp(nonce, CSP_SOURCE, []).includes(`'nonce-${nonce}'`));
  });
});

describe("buildShell", () => {
  it("is exactly the static shell, and holds nothing the caller did not pass in", () => {
    assert.equal(
      shell(),
      [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        `    <meta http-equiv="Content-Security-Policy" content="${SPEC_CSP}" />`,
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        "    <style>",
        ".mc-stylesentinel{color:red}",
        "    </style>",
        "  </head>",
        "  <body>",
        '    <div id="mc-toolbar"></div>',
        '    <div id="mc-banner" role="status"></div>',
        '    <div id="mc-header"></div>',
        '    <div id="mc-attachments"></div>',
        '    <div id="mc-body"></div>',
        '    <script nonce="NONCESENTINELnoncesentinel0" ' +
          'src="vscode-webview-resource://scriptsentinel/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
  });

  it("places each sentinel exactly where it belongs and nowhere else", () => {
    const html = shell();
    assert.equal(occurrences(html, NONCE), 2);
    assert.equal(occurrences(html, CSP_SOURCE), 1);
    assert.equal(occurrences(html, SCRIPT_URI), 1);
    assert.equal(occurrences(html, STYLES), 1);
    assert.equal(occurrences(html, `content="${SPEC_CSP}"`), 1);
    assert.equal(occurrences(html, `nonce="${NONCE}" src="${SCRIPT_URI}"`), 1);
    assert.equal(occurrences(html, `<style>\n${STYLES}\n`), 1);
  });

  it("has exactly one script tag, and no unsafe or remote source", () => {
    const html = shell();
    assert.equal(html.match(SCRIPT_TAG)?.length, 1);
    assert.equal(occurrences(html, "unsafe-eval"), 0);
    assert.equal(SCHEME_SOURCE_HTTPS.test(html), false);
    assert.equal(occurrences(html, "http://"), 0);
    assert.equal(occurrences(html, "//cdn."), 0);
    assert.equal(occurrences(html, "<link"), 0);
    assert.equal(occurrences(html, "<iframe"), 0);
    assert.equal(occurrences(html, "@import"), 0);
    assert.equal(occurrences(html, "unsafe-inline"), 1);
  });

  it("carries the per-message image allow into the shell CSP and nothing else", () => {
    const html = buildShell({
      nonce: NONCE,
      cspSource: CSP_SOURCE,
      scriptUri: SCRIPT_URI,
      styles: STYLES,
      allowedOrigins: ["https://cdn.example.com"],
    });
    assert.equal(occurrences(html, "https://cdn.example.com"), 1);
    assert.equal(occurrences(html, `content="${buildCsp(NONCE, CSP_SOURCE, ["https://cdn.example.com"])}"`), 1);
    assert.equal(html.match(SCRIPT_TAG)?.length, 1);
  });

  it("refuses a script URI that is not a quote-free known-scheme URI", () => {
    for (const scriptUri of [
      'vscode-webview-resource://x/main.js" onload="alert(1)',
      "javascript:alert(1)",
      "vscode-webview-resource://x/main.js?a=1&b=2",
      "https://cdn.example.com/main.js#'",
      "main.js",
      "",
    ]) {
      assert.throws(
        () => buildShell({ nonce: NONCE, cspSource: CSP_SOURCE, scriptUri, styles: STYLES }),
        /script URI/,
      );
    }
  });

  it("refuses a stylesheet that could close the style element", () => {
    for (const styles of [".x{}</style><script>alert(1)</script>", ".x{}<!--", "a{content:'</STYLE>'}"]) {
      assert.throws(
        () => buildShell({ nonce: NONCE, cspSource: CSP_SOURCE, scriptUri: SCRIPT_URI, styles }),
        /stylesheet/,
      );
    }
  });

  it("refuses to build a shell around an invalid nonce or origin", () => {
    assert.throws(
      () => buildShell({ nonce: "short", cspSource: CSP_SOURCE, scriptUri: SCRIPT_URI, styles: STYLES }),
      /nonce/,
    );
    assert.throws(
      () =>
        buildShell({
          nonce: NONCE,
          cspSource: CSP_SOURCE,
          scriptUri: SCRIPT_URI,
          styles: STYLES,
          allowedOrigins: ["http://cdn.example.com"],
        }),
      /allowed image origin/,
    );
  });
});

describe("protocol guards", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  function renderFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "render",
      messageId: 4213,
      mode: "html",
      header: { subject: "Invoice", from: "a@example.com", to: "b@example.com", date: "2026-08-30T12:34:56Z", tags: [] },
      bodyHtml: "<table><tr><td>hi</td></tr></table>",
      attachments: [],
      inlineImages: {},
      allowedOrigins: [],
      ...overrides,
    };
  }

  it("passes a well-formed render frame and keeps only the declared keys", () => {
    const parsed = parseHostMessage(renderFrame({ evil: "extra", constructor: "no" }));
    assert.ok(parsed !== undefined && parsed.type === "render");
    assert.deepEqual(Object.keys(parsed).sort(), [
      "allowedOrigins",
      "attachments",
      "bodyHtml",
      "header",
      "inlineImages",
      "messageId",
      "mode",
      "type",
    ]);
  });

  it("refuses a render frame whose allowed origins are not https origins", () => {
    assert.equal(parseHostMessage(renderFrame({ allowedOrigins: ["http://cdn.example.com"] })), undefined);
    assert.equal(parseHostMessage(renderFrame({ allowedOrigins: ["https:"] })), undefined);
    assert.equal(parseHostMessage(renderFrame({ allowedOrigins: origins(33) })), undefined);
    assert.ok(parseHostMessage(renderFrame({ allowedOrigins: origins(32) })) !== undefined);
  });

  it("keeps only data: raster images among the inline images, and cannot be prototype-poisoned", () => {
    const parsed = parseHostMessage(
      renderFrame({
        inlineImages: {
          "cid:logo@example.com": PNG,
          "cid:script@example.com": "javascript:alert(1)",
          "cid:remote@example.com": "https://cdn.example.com/pixel.gif",
          "cid:svg@example.com": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
          "cid:text@example.com": "data:text/html;base64,PHNjcmlwdD4=",
          __proto__: PNG,
        },
      }),
    );
    assert.ok(parsed !== undefined && parsed.type === "render");
    assert.deepEqual(Object.entries(parsed.inlineImages), [["cid:logo@example.com", PNG]]);
    assert.equal(Object.getPrototypeOf(parsed.inlineImages), null);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it("refuses a header that is not a hardened single line", () => {
    assert.equal(parseHostMessage(renderFrame({ header: { subject: "a\nb", from: "", to: "", date: "", tags: [] } })), undefined);
    assert.equal(parseHostMessage(renderFrame({ header: { subject: "a", from: "", to: "", date: "", tags: [1] } })), undefined);
    assert.equal(parseHostMessage(renderFrame({ header: undefined })), undefined);
  });

  it("ignores a frame with an unknown or absent type", () => {
    assert.equal(parseHostMessage({ type: "eval", code: "1" }), undefined);
    assert.equal(parseHostMessage(renderFrame({ type: "Render" })), undefined);
    assert.equal(parseWebviewMessage({ type: "openTerminal" }), undefined);
    assert.equal(parseWebviewMessage(null), undefined);
    assert.equal(parseWebviewMessage("ready"), undefined);
    assert.equal(parseWebviewMessage([{ type: "ready" }]), undefined);
  });

  it("names a rejected frame in log-safe terms only", () => {
    assert.equal(messageTypeOf({ type: "openLink" }), "openLink");
    assert.equal(messageTypeOf({ type: "a‮b" }), "(unprintable type)");
    assert.equal(messageTypeOf({ type: "x".repeat(64) }), "(no type)");
    assert.equal(messageTypeOf({}), "(no type)");
    assert.equal(messageTypeOf(undefined), "(no type)");
  });

  it("lets only https and mailto links reach openExternal", () => {
    for (const href of ["https://example.com/a?b=c#d", "mailto:someone@example.com?subject=hi", "HTTPS://Example.com"]) {
      assert.deepEqual(parseWebviewMessage({ type: "openLink", href }), { type: "openLink", href });
    }
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "command:workbench.action.terminal.new",
      "vscode://ms-vscode.remote",
      "data:text/html,<script>alert(1)</script>",
      "http://example.com",
      "/etc/passwd",
      "https://",
      "https:// example.com",
      "",
      42,
    ]) {
      assert.equal(parseWebviewMessage({ type: "openLink", href }), undefined);
    }
  });

  it("takes a save request only for a plausible attachment index", () => {
    assert.deepEqual(parseWebviewMessage({ type: "saveAttachment", index: 0 }), { type: "saveAttachment", index: 0 });
    for (const index of [-1, 1.5, "0", Number.NaN, 10_001, undefined]) {
      assert.equal(parseWebviewMessage({ type: "saveAttachment", index }), undefined);
    }
  });

  it("reduces a violation report to an origin", () => {
    assert.deepEqual(parseWebviewMessage({ type: "cspViolation", directive: "img-src", blockedOrigin: "https://cdn.example.com" }), {
      type: "cspViolation",
      directive: "img-src",
      blockedOrigin: "https://cdn.example.com",
    });
    assert.equal(
      parseWebviewMessage({ type: "cspViolation", directive: "img-src", blockedOrigin: "https://cdn.example.com/track?id=1" }),
      undefined,
    );
    assert.equal(parseWebviewMessage({ type: "cspViolation", directive: "img src", blockedOrigin: "" }), undefined);
    assert.equal(toOrigin("https://cdn.example.com/track?id=1"), "https://cdn.example.com");
    assert.equal(toOrigin("data:image/png;base64,AAAA"), "data:");
    assert.equal(toOrigin("<not a uri>"), "");
  });

  it("bounds the blocked-image count and the render timing it is told", () => {
    assert.deepEqual(parseWebviewMessage({ type: "blockedImages", messageId: 1, count: 14, origins: ["https://cdn.example.com"] }), {
      type: "blockedImages",
      messageId: 1,
      count: 14,
      origins: ["https://cdn.example.com"],
    });
    assert.equal(parseWebviewMessage({ type: "blockedImages", messageId: 1, count: 14, origins: ["*"] }), undefined);
    assert.equal(parseWebviewMessage({ type: "rendered", messageId: 1, elapsedMs: Number.POSITIVE_INFINITY }), undefined);
    assert.deepEqual(parseWebviewMessage({ type: "rendered", messageId: 1, elapsedMs: 12.5 }), {
      type: "rendered",
      messageId: 1,
      elapsedMs: 12.5,
    });
  });

  it("keeps a status line to one bounded line of host text", () => {
    assert.deepEqual(parseHostMessage({ type: "status", text: "12 remote images blocked" }), {
      type: "status",
      text: "12 remote images blocked",
    });
    assert.equal(parseHostMessage({ type: "status", text: "a".repeat(401) }), undefined);
    assert.equal(parseHostMessage({ type: "status", text: "two\nlines" }), undefined);
  });
});
