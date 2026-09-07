import assert from "node:assert/strict";

import { filterCss } from "../../src/webview/sanitize.js";

import { clean } from "./harness.test.js";

interface Vector {
  readonly name: string;
  readonly css: string;
  readonly origin: string;
}

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

const VECTORS: readonly Vector[] = [
  { name: "a plain url()", css: "background:url(https://a.example/x.gif)", origin: "https://a.example" },
  { name: "url spelled with one CSS escape", css: "background:u\\72l(https://b.example/x.gif)", origin: "https://b.example" },
  { name: "url spelled entirely in hex escapes", css: "background:\\75\\72\\6c(https://c.example/x.gif)", origin: "https://c.example" },
  { name: "url with space-terminated escapes", css: "background:\\75 \\72 \\6c (https://d.example/x.gif)", origin: "https://d.example" },
  { name: "url split by a comment", css: "background:ur/**/l(https://e.example/x.gif)", origin: "https://e.example" },
  { name: "image-set() with a string", css: 'background:image-set("https://f.example/x.png" 1x)', origin: "https://f.example" },
  { name: "-webkit-image-set() wrapping url()", css: "background:-webkit-image-set(url(https://g.example/x.png) 1x)", origin: "https://g.example" },
  { name: "image()", css: 'background:image("https://h.example/x.png")', origin: "https://h.example" },
  { name: "src() in a font face", css: 'src:src("https://i.example/f.woff2")', origin: "https://i.example" },
  { name: "cross-fade()", css: "background:cross-fade(url(https://j.example/a.png), url(https://j.example/b.png), 50%)", origin: "https://j.example" },
  { name: "@import as a bare string", css: '@import "https://k.example/x.css";', origin: "https://k.example" },
  { name: "@import spelled with an escape", css: '@\\69mport "https://l.example/x.css";', origin: "https://l.example" },
  { name: "@import in upper case", css: "@IMPORT URL(https://m.example/x.css);", origin: "https://m.example" },
  { name: "an escaped colon inside the URL", css: "background:url(https\\3a//n.example/x.gif)", origin: "https://n.example" },
];

const LEAK = /https?:|\\[0-9a-f]|image-set|cross-fade|@import/i;

describe("CSS fetch bypasses", () => {
  for (const vector of VECTORS) {
    it(`neutralises and counts ${vector.name}`, () => {
      const reported: string[] = [];
      const out = filterCss(vector.css, (origin) => reported.push(origin));
      assert.doesNotMatch(out, LEAK, out);
      assert.deepEqual([...new Set(reported)], [vector.origin]);
    });

    it(`does so when ${vector.name} arrives through a style attribute`, () => {
      const cleaned = clean(`<div style="${vector.css.replaceAll('"', "&quot;")}">x</div>`);
      const style = cleaned.element.querySelector("div")?.getAttribute("style") ?? "";
      assert.doesNotMatch(style, LEAK, style);
      assert.deepEqual(cleaned.census.origins, [vector.origin]);
    });

    it(`does so when ${vector.name} arrives through a <style> element`, () => {
      const cleaned = clean(`<style>p{${vector.css}}</style>`);
      const css = cleaned.element.querySelector("style")?.textContent ?? "";
      assert.doesNotMatch(css, LEAK, css);
      assert.deepEqual(cleaned.census.origins, [vector.origin]);
    });
  }

  it("removes a URL that survives in a non-fetching position without blanking the stylesheet", () => {
    const out = filterCss('p{color:red} q::after{content:"https://o.example/x"} r{color:blue}', () => undefined);
    assert.match(out, /p\{color:red\}/);
    assert.match(out, /r\{color:blue\}/);
    assert.doesNotMatch(out, /o\.example/);
  });

  it("keeps a data:image url() and its surrounding declarations intact", () => {
    const out = filterCss(`background:url(${PIXEL}) no-repeat;color:#123`, () => {
      assert.fail("a data: image is not remote");
    });
    assert.equal(out, `background:url(${PIXEL}) no-repeat;color:#123`);
  });

  it("does not let a data: image inside image-set() hide a remote sibling", () => {
    const reported: string[] = [];
    const out = filterCss(`background:image-set(url(${PIXEL}) 1x, url(https://p.example/x.png) 2x)`, (o) => reported.push(o));
    assert.equal(out, "background:none");
    assert.deepEqual(reported, ["https://p.example"]);
  });

  it("closes an unterminated fetch function at the end of the text", () => {
    const reported: string[] = [];
    const out = filterCss('background:image-set("https://q.example/x.png', (o) => reported.push(o));
    assert.doesNotMatch(out, LEAK, out);
    assert.deepEqual(reported, ["https://q.example"]);
  });

  it("decodes escapes the way the browser does: NUL, surrogates and out-of-range become U+FFFD", () => {
    assert.equal(filterCss("a\\0 b\\d800 c\\110000 d", () => undefined), "a�b�c�d");
  });
});

describe("CSS selector scoping", () => {
  it("rewrites a body selector to the mail wrapper in every combinator position", () => {
    const out = filterCss("body{margin:0} body .x{color:red} body>td{x:y} body.dark,body#id{a:b} body:hover{c:d}", () => undefined);
    assert.equal(out, ".mc-mail{margin:0} .mc-mail .x{color:red} .mc-mail>td{x:y} .mc-mail.dark,.mc-mail#id{a:b} .mc-mail:hover{c:d}");
  });

  it("leaves tbody, .body, #body, a body font name and a body string alone", () => {
    const css = 'tbody{a:b} .body{a:b} #body{a:b} p{font-family:Body;content:"body"}';
    assert.equal(filterCss(css, () => undefined), css);
  });

  it("neutralises :host and :host-context so mail cannot restyle its own container", () => {
    const out = filterCss(":host{position:fixed} :host(.a){x:y} :host-context(.b) p{c:d} .hosted{e:f}", () => undefined);
    assert.equal(out, ":not(*){position:fixed} :not(*)(.a){x:y} :not(*)(.b) p{c:d} .hosted{e:f}");
  });
});
