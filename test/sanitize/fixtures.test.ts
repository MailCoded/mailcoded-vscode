import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REMOTE_IMAGE_ATTRIBUTE } from "../../src/webview/sanitize.js";

import { attributeNames, attributeValues, clean } from "./harness.test.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/html/", import.meta.url));

/** Only these three are named in the corpus README as the ones that matter; the rest of the
 * engine's 37 .eml files have no HTML part at all, so `scripts/gen-html-fixtures.mjs` writes
 * nothing for them. */
const REQUIRED = ["011-html-only.html", "016-inline-cid-image.html", "036-html-lt-not-a-tag.html"];

const names = readdirSync(FIXTURES)
  .filter((entry) => entry.endsWith(".html"))
  .sort();

function body(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("the generated corpus", () => {
  it("exists", () => {
    assert.ok(names.length >= REQUIRED.length, `only ${String(names.length)} fixture(s) generated`);
  });

  for (const required of REQUIRED) {
    it(`includes ${required}`, () => {
      assert.ok(names.includes(required), `run scripts/gen-html-fixtures.mjs`);
    });
  }
});

describe("every generated fixture", () => {
  for (const name of names) {
    it(`${name} sanitises without throwing and leaves nothing executable`, () => {
      const cleaned = clean(body(name), {
        inlineImages: { "logo016@example.com": "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
        allowedOrigins: [],
      });
      const lowered = cleaned.html.toLowerCase();

      assert.ok(!lowered.includes("script"), cleaned.html);
      assert.ok(!lowered.includes("onerror"), cleaned.html);
      assert.ok(!lowered.includes("javascript:"), cleaned.html);
      assert.deepEqual(
        attributeNames(cleaned.element).filter((attribute) => attribute.startsWith("on")),
        [],
        cleaned.html,
      );
      for (const value of attributeValues(cleaned.element)) {
        assert.doesNotMatch(value, /http:\/\//i, cleaned.html);
        assert.doesNotMatch(value, /javascript:/i, cleaned.html);
      }
    });
  }
});

describe("011-html-only", () => {
  it("loses its script and its javascript: link but keeps its heading and its <style>", () => {
    const cleaned = clean(body("011-html-only.html"));
    assert.equal(cleaned.element.getElementsByTagName("script").length, 0);
    assert.equal(cleaned.element.querySelector("a")?.getAttribute("href") ?? null, null);
    assert.equal(cleaned.element.querySelector("h1")?.textContent, "Big news");
    assert.match(cleaned.element.querySelector("style")?.textContent ?? "", /color:red/);
  });
});

describe("002-multipart-alternative", () => {
  it("blocks its tracking pixel and reports the origin", () => {
    const cleaned = clean(body("002-multipart-alternative.html"));
    assert.equal(cleaned.census.blocked, 1);
    assert.deepEqual(cleaned.census.origins, ["https://tracker.example.net"]);
    assert.equal(cleaned.element.querySelector("img")?.getAttribute("src") ?? null, null);
  });
});

describe("016-inline-cid-image", () => {
  it("resolves the inline logo from the trusted map and blocks nothing", () => {
    const cleaned = clean(body("016-inline-cid-image.html"), {
      inlineImages: { "logo016@example.com": "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
      allowedOrigins: [],
    });
    assert.match(cleaned.element.querySelector("img")?.getAttribute("src") ?? "", /^data:image\/gif;base64,/);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("drops the same logo when the host resolved no inline part", () => {
    const cleaned = clean(body("016-inline-cid-image.html"), { inlineImages: {}, allowedOrigins: [] });
    const image = cleaned.element.querySelector("img");
    assert.equal(image?.getAttribute("src") ?? null, null);
    assert.equal(image?.getAttribute(REMOTE_IMAGE_ATTRIBUTE) ?? null, null);
  });
});

describe("036-html-lt-not-a-tag", () => {
  it("keeps the text around a '<' that is not a tag", () => {
    const cleaned = clean(body("036-html-lt-not-a-tag.html"));
    const text = cleaned.element.textContent ?? "";
    assert.match(text, /wire instructions changed/);
    assert.match(text, /Regards, CFO/);
  });
});
