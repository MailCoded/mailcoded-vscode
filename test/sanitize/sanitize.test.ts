import assert from "node:assert/strict";

import {
  ALLOWED_URI_REGEXP,
  FORBIDDEN_EVENT_ATTRIBUTES,
  FORBIDDEN_TAGS,
  REMOTE_IMAGE_ATTRIBUTE,
  SANITIZER_CONFIG,
} from "../../src/webview/sanitize.js";

import { attributeNames, attributeValues, clean, tagsIn } from "./harness.test.js";

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function href(html: string): string | null {
  const anchor = clean(html).element.querySelector("a");
  return anchor === null ? null : anchor.getAttribute("href");
}

describe("SPEC 6.3 forbidden tags", () => {
  for (const tag of FORBIDDEN_TAGS) {
    it(`drops <${tag}>, however it is spelled or nested`, () => {
      const odd = `${tag.slice(0, 1).toUpperCase()}${tag.slice(1).toUpperCase()}`;
      const shapes = [
        `<${tag}>alert(1)</${tag}>`,
        `<div><p><${tag} src="https://evil.example/x"></${tag}></p></div>`,
        `<${odd}>alert(1)</${odd}>`,
        `<${tag}/>`,
        `<${tag} />text`,
        `<div><${tag}><${tag}></${tag}></${tag}></div>`,
      ];
      for (const shape of shapes) {
        const cleaned = clean(shape);
        assert.equal(
          cleaned.element.getElementsByTagName(tag).length,
          0,
          `${shape} left a <${tag}> behind: ${cleaned.html}`,
        );
        assert.ok(!tagsIn(cleaned.element).includes(tag), `${shape} -> ${cleaned.html}`);
      }
    });
  }

  it("drops a tag name broken up by a comment rather than reassembling it", () => {
    const cleaned = clean("<scr<!---->ipt>alert(1)</script><div>after</div>");
    assert.equal(cleaned.element.getElementsByTagName("script").length, 0);
    assert.ok(!cleaned.html.toLowerCase().includes("<script"));
  });

  it("keeps the ordinary furniture of HTML mail", () => {
    const cleaned = clean(
      "<table><tbody><tr><td><p><b>bold</b> and <i>italic</i></p></td></tr></tbody></table>" +
        "<style>td{padding:2px}</style><blockquote>quoted</blockquote>",
    );
    const tags = tagsIn(cleaned.element);
    for (const tag of ["table", "tr", "td", "p", "b", "i", "style", "blockquote"]) {
      assert.ok(tags.includes(tag), `${tag} was dropped: ${cleaned.html}`);
    }
  });
});

describe("event handler attributes", () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    "<svg onload=alert(1)></svg>",
    "<body onload=alert(1)><p>text</p></body>",
    "<img src=x on\nerror=alert(1)>",
    "<img src=x on error=alert(1)>",
    '<div ONCLICK="alert(1)">click</div>',
    '<div onmouseover \n = "alert(1)">hover</div>',
  ];

  for (const payload of payloads) {
    it(`strips every on* attribute from ${JSON.stringify(payload)}`, () => {
      const cleaned = clean(payload);
      const offending = attributeNames(cleaned.element).filter((name) => name.startsWith("on"));
      assert.deepEqual(offending, [], cleaned.html);
      assert.ok(!cleaned.html.toLowerCase().includes("alert(1)"), cleaned.html);
    });
  }

  it("keeps no attribute whose name merely begins with 'on' either", () => {
    const cleaned = clean('<div onbogus="x" only="y">t</div>');
    assert.ok(!attributeNames(cleaned.element).includes("onbogus"), cleaned.html);
  });
});

describe("the URL scheme allowlist", () => {
  const rejected = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "vscode://ms-vscode.remote/x",
    "command:workbench.action.terminal.new",
    "/relative/path",
    "//evil.example/x",
    "http://insecure.example/x",
    "  javascript:alert(1)",
  ];

  for (const value of rejected) {
    it(`drops href=${JSON.stringify(value)}`, () => {
      assert.equal(href(`<a href="${value}">link</a>`), null);
    });
  }

  it("keeps https and mailto", () => {
    assert.equal(href('<a href="https://ok.example/x?y=1#z">link</a>'), "https://ok.example/x?y=1#z");
    assert.equal(href('<a href="mailto:a@b.example">mail</a>'), "mailto:a@b.example");
  });

  it("keeps the anchor element itself so its text survives a dropped href", () => {
    const cleaned = clean('<a href="javascript:alert(1)">the label</a>');
    assert.equal(cleaned.element.querySelectorAll("a").length, 1);
    assert.equal(cleaned.element.textContent, "the label");
  });

  it("drops the attributes that carry a second URL", () => {
    const cleaned = clean(
      '<img srcset="https://x.example/a 1x" src="https://x.example/b">' +
        '<a href="https://ok.example" target="_blank" ping="https://p.example">l</a>' +
        '<video poster="https://v.example/p.jpg"></video>' +
        '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    );
    const names = attributeNames(cleaned.element);
    for (const name of ["srcset", "target", "ping", "poster", "xlink:href"]) {
      assert.ok(!names.includes(name), `${name} survived: ${cleaned.html}`);
    }
  });
});

describe("the tags SPEC 6.3 names one by one", () => {
  it("drops <base href>", () => {
    const cleaned = clean('<base href="https://evil.example/"><a href="/x">l</a>');
    assert.equal(cleaned.element.getElementsByTagName("base").length, 0);
    assert.equal(cleaned.element.querySelector("a")?.getAttribute("href") ?? null, null);
  });

  it("drops <meta http-equiv=refresh>", () => {
    const cleaned = clean('<meta http-equiv="refresh" content="0;url=https://evil.example">');
    assert.equal(cleaned.element.getElementsByTagName("meta").length, 0);
    assert.ok(!attributeNames(cleaned.element).includes("http-equiv"));
  });

  it("drops <form action> but leaves its inert content", () => {
    const cleaned = clean('<form action="https://evil.example" method="post"><input name="a"></form>');
    assert.equal(cleaned.element.getElementsByTagName("form").length, 0);
    assert.ok(!attributeNames(cleaned.element).includes("action"));
  });

  it("drops <link rel=stylesheet>", () => {
    const cleaned = clean('<link rel="stylesheet" href="https://evil.example/x.css">');
    assert.equal(cleaned.element.getElementsByTagName("link").length, 0);
    assert.equal(cleaned.html, "");
  });

  it("drops <object> and <embed>", () => {
    const cleaned = clean('<object data="https://evil.example/x"></object><embed src="https://evil.example/y">');
    assert.equal(cleaned.element.getElementsByTagName("object").length, 0);
    assert.equal(cleaned.element.getElementsByTagName("embed").length, 0);
  });
});

describe("svg", () => {
  it("drops <use>, which is a fetch-and-include instruction", () => {
    const cleaned = clean('<svg><use href="#x"></use><use xlink:href="https://evil.example/s#i"></use></svg>');
    assert.equal(cleaned.element.getElementsByTagName("use").length, 0);
    assert.ok(!tagsIn(cleaned.element).includes("use"), cleaned.html);
  });

  it("drops <foreignObject>, which reopens the HTML namespace inside svg", () => {
    const cleaned = clean("<svg><foreignObject><script>alert(1)</script><p>x</p></foreignObject></svg>");
    assert.ok(!tagsIn(cleaned.element).includes("foreignobject"), cleaned.html);
    assert.equal(cleaned.element.getElementsByTagName("script").length, 0);
  });

  it("still allows plain svg shapes", () => {
    const cleaned = clean('<svg viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"></circle></svg>');
    assert.ok(tagsIn(cleaned.element).includes("circle"), cleaned.html);
  });
});

describe("mXSS", () => {
  it("survives the noscript title break-out", () => {
    const cleaned = clean('<noscript><p title="</noscript><img src=x onerror=alert(1)>">');
    assert.equal(cleaned.element.getElementsByTagName("script").length, 0);
    assert.deepEqual(
      attributeNames(cleaned.element).filter((name) => name.startsWith("on")),
      [],
      cleaned.html,
    );
    assert.ok(!cleaned.html.toLowerCase().includes("onerror"), cleaned.html);
  });

  it("survives the math namespace confusion", () => {
    const cleaned = clean(
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src onerror=alert(1)>">',
    );
    assert.equal(cleaned.element.getElementsByTagName("script").length, 0);
    assert.deepEqual(
      attributeNames(cleaned.element).filter((name) => name.startsWith("on")),
      [],
      cleaned.html,
    );
    assert.ok(!cleaned.html.toLowerCase().includes("onerror"), cleaned.html);
  });

  it("survives an svg style break-out", () => {
    const cleaned = clean('<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">');
    assert.deepEqual(
      attributeNames(cleaned.element).filter((name) => name.startsWith("on")),
      [],
      cleaned.html,
    );
  });
});

describe("CSS", () => {
  it("neutralises and counts a remote background image in a style attribute", () => {
    const cleaned = clean('<div style="background:url(https://tracker.example/a.gif)">x</div>');
    const style = cleaned.element.querySelector("div")?.getAttribute("style") ?? "";
    assert.ok(!style.includes("tracker.example"), style);
    assert.match(style, /none/);
    assert.equal(cleaned.census.blocked, 1);
    assert.deepEqual(cleaned.census.origins, ["https://tracker.example"]);
  });

  it("neutralises and counts an @import in a <style> element", () => {
    const cleaned = clean("<style>@import url(https://x.example/y.css); p{color:red}</style>");
    const css = cleaned.element.querySelector("style")?.textContent ?? "";
    assert.ok(!css.includes("@import"), css);
    assert.ok(!css.includes("x.example"), css);
    assert.match(css, /p\{color:red\}/);
    assert.equal(cleaned.census.blocked, 1);
    assert.deepEqual(cleaned.census.origins, ["https://x.example"]);
  });

  it("strips expression(), -moz-binding and behavior:", () => {
    const cleaned = clean(
      '<style>p{width:expression(alert(1));-moz-binding:url(https://e.example/x.xml);behavior:url(#default#time2)}</style>' +
        '<div style="width:expression(alert(2))">x</div>',
    );
    const css = `${cleaned.element.querySelector("style")?.textContent ?? ""} ${
      cleaned.element.querySelector("div")?.getAttribute("style") ?? ""
    }`.toLowerCase();
    assert.ok(!css.includes("expression("), css);
    assert.ok(!css.includes("-moz-binding"), css);
    assert.ok(!css.includes("behavior:"), css);
  });

  it("keeps a data:image url in CSS, which the policy already allows", () => {
    const cleaned = clean(`<div style="background-image:url(${PIXEL})">x</div>`);
    assert.match(cleaned.element.querySelector("div")?.getAttribute("style") ?? "", /data:image\/gif/);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("takes !important away from mail CSS, which would otherwise outrank the reader's chrome", () => {
    const cleaned = clean("<style>#mc-banner{display:none !important}</style>");
    const css = cleaned.element.querySelector("style")?.textContent ?? "";
    assert.ok(!css.toLowerCase().includes("important"), css);
  });

  it("survives CSS with no closing brace or semicolon", () => {
    const cleaned = clean("<style>@import url(https://x.example/y.css)</style>");
    const css = cleaned.element.querySelector("style")?.textContent ?? "";
    assert.equal(css.trim(), "");
    assert.equal(cleaned.census.blocked, 1);
  });
});

describe("sources the image policy can never govern", () => {
  it("drops a video, audio, source or track src without counting it as an image", () => {
    const cleaned = clean(
      '<video src="https://v.example/a.mp4" poster="https://p.example/a.png"><source src="https://s.example/a.webm"><track src="https://t.example/a.vtt"></video><audio src="https://a.example/a.mp3"></audio>',
    );
    assert.ok(!attributeValues(cleaned.element).some((value) => /[vsta]\.example/.test(value)), cleaned.html);
    assert.equal(cleaned.census.blocked, 1);
    assert.deepEqual(cleaned.census.origins, ["https://p.example"]);
  });

  it("drops href on an svg element that is neither a link nor an image", () => {
    const cleaned = clean(
      '<svg><filter id="f"><feImage href="https://fe.example/i.png"/></filter><pattern href="https://pa.example/p.svg"/><textPath href="https://tp.example/t"/></svg>',
    );
    assert.ok(!attributeNames(cleaned.element).includes("href"), cleaned.html);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("drops a same-document href too: ids are namespaced, so it could never resolve", () => {
    const cleaned = clean('<svg><linearGradient id="g"/><linearGradient href="#g"/><textPath href="#p"/></svg>');
    assert.equal(cleaned.element.querySelectorAll("[href]").length, 0);
    assert.equal(cleaned.element.querySelectorAll("linearGradient").length, 2);
  });

  it("counts and parks an svg image href like an img src", () => {
    const cleaned = clean('<svg><image href="https://i.example/x.png"/></svg>');
    const image = cleaned.element.querySelector("image");
    assert.equal(image?.getAttribute("href"), null);
    assert.equal(image?.getAttribute(REMOTE_IMAGE_ATTRIBUTE), "https://i.example");
    assert.deepEqual(cleaned.census.origins, ["https://i.example"]);
  });

  it("returns an empty fragment, not a crash, when the parse has no body", () => {
    for (const html of ['<frameset><frame src="https://f.example/"></frameset>', "<frameset></frameset>", "<html><head></head></html>"]) {
      const cleaned = clean(html);
      assert.equal(cleaned.element.childNodes.length, 0, html);
      assert.equal(cleaned.census.blocked, 0);
    }
  });
});

describe("inline cid images", () => {
  const images = { "logo@example.com": PIXEL, "<logo@example.com>": PIXEL };

  it("resolves a cid that is a key of the trusted map", () => {
    const cleaned = clean('<img src="cid:logo@example.com">', { inlineImages: images, allowedOrigins: [] });
    assert.equal(cleaned.element.querySelector("img")?.getAttribute("src"), PIXEL);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("resolves the angle-bracketed spelling too", () => {
    const cleaned = clean('<img src="cid:<logo@example.com>">', { inlineImages: images, allowedOrigins: [] });
    assert.equal(cleaned.element.querySelector("img")?.getAttribute("src"), PIXEL);
  });

  it("drops a cid that is not a key", () => {
    const cleaned = clean('<img src="cid:other@example.com">', { inlineImages: images, allowedOrigins: [] });
    assert.equal(cleaned.element.querySelector("img")?.getAttribute("src") ?? null, null);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("does not mistake a prototype property for a key", () => {
    for (const cid of ["__proto__", "constructor", "toString"]) {
      const cleaned = clean(`<img src="cid:${cid}">`, { inlineImages: images, allowedOrigins: [] });
      assert.equal(cleaned.element.querySelector("img")?.getAttribute("src") ?? null, null, cid);
    }
  });

  it("refuses a map entry that is not one of the four inline image types", () => {
    const cleaned = clean('<img src="cid:x">', {
      inlineImages: { x: "data:image/svg+xml;base64,PHN2Zy8+" },
      allowedOrigins: [],
    });
    assert.equal(cleaned.element.querySelector("img")?.getAttribute("src") ?? null, null);
  });

  it("drops an attacker's own data: src", () => {
    const cleaned = clean('<img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/gif;base64,AAAA">');
    assert.deepEqual(attributeValues(cleaned.element), [], cleaned.html);
  });
});

describe("the remote image census", () => {
  it("counts every reference but names each origin once", () => {
    const cleaned = clean(
      '<img src="https://a.example/1.gif"><img src="https://a.example/2.gif"><img src="https://b.example/3.gif">',
    );
    assert.equal(cleaned.census.blocked, 3);
    assert.deepEqual(cleaned.census.origins, ["https://a.example", "https://b.example"]);
  });

  it("keeps the port in an origin and treats it as distinct", () => {
    const cleaned = clean('<img src="https://a.example:8443/1.gif"><img src="https://a.example/2.gif">');
    assert.deepEqual(cleaned.census.origins, ["https://a.example:8443", "https://a.example"]);
  });

  it("moves the origin to the parking attribute and removes the source", () => {
    const cleaned = clean('<img src="https://a.example/1.gif?id=secret" alt="logo">');
    const image = cleaned.element.querySelector("img");
    assert.equal(image?.getAttribute("src") ?? null, null);
    assert.equal(image?.getAttribute(REMOTE_IMAGE_ATTRIBUTE), "https://a.example");
    assert.ok(!cleaned.html.includes("secret"), cleaned.html);
  });

  it("counts a legacy background attribute", () => {
    const cleaned = clean('<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>');
    assert.equal(cleaned.census.blocked, 1);
    assert.ok(!attributeNames(cleaned.element).includes("background"), cleaned.html);
  });

  it("keeps a source the host has already allowed for this render", () => {
    const cleaned = clean('<img src="https://a.example/1.gif"><img src="https://b.example/2.gif">', {
      inlineImages: {},
      allowedOrigins: ["https://a.example"],
    });
    assert.equal(cleaned.element.querySelectorAll("img")[0]?.getAttribute("src"), "https://a.example/1.gif");
    assert.equal(cleaned.census.blocked, 1);
    assert.deepEqual(cleaned.census.origins, ["https://b.example"]);
  });

  it("ignores a parking attribute the mail supplied itself", () => {
    const cleaned = clean(`<img ${REMOTE_IMAGE_ATTRIBUTE}="https://evil.example">`);
    assert.equal(cleaned.element.querySelector("img")?.getAttribute(REMOTE_IMAGE_ATTRIBUTE) ?? null, null);
    assert.equal(cleaned.census.blocked, 0);
  });

  it("starts each render from zero", () => {
    const first = clean('<img src="https://a.example/1.gif">');
    assert.equal(first.census.blocked, 1);
    const second = clean("<p>nothing remote</p>");
    assert.equal(second.census.blocked, 0);
    assert.deepEqual(second.census.origins, []);
  });
});

describe("the effective configuration", () => {
  it("still forbids every tag SPEC 6.3 names", () => {
    assert.deepEqual([...(SANITIZER_CONFIG.FORBID_TAGS ?? [])].sort(), [
      "base",
      "embed",
      "form",
      "iframe",
      "link",
      "meta",
      "object",
      "script",
    ]);
  });

  it("forbids on* attributes by name as well as by hook", () => {
    const forbidden = SANITIZER_CONFIG.FORBID_ATTR ?? [];
    assert.ok(forbidden.length > 50);
    assert.deepEqual(forbidden.filter((name) => !name.startsWith("on")), []);
    for (const name of ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onanimationend"]) {
      assert.ok(forbidden.includes(name), `${name} is not in FORBID_ATTR`);
    }
    assert.deepEqual([...forbidden], [...FORBIDDEN_EVENT_ATTRIBUTES]);
  });

  it("allows https and mailto and nothing else", () => {
    assert.equal(SANITIZER_CONFIG.ALLOWED_URI_REGEXP?.source, ALLOWED_URI_REGEXP.source);
    assert.match("https://x", ALLOWED_URI_REGEXP);
    assert.match("mailto:a@b", ALLOWED_URI_REGEXP);
    for (const value of ["http://x", "data:x", "javascript:x", "cid:x", "tel:1", "ftp://x", "/x"]) {
      assert.doesNotMatch(value, ALLOWED_URI_REGEXP);
    }
  });

  it("namespaces id and name, a local hardening above SPEC 6.3", () => {
    assert.equal(SANITIZER_CONFIG.SANITIZE_NAMED_PROPS, true);
    const cleaned = clean('<div id="mc-body"><a name="body">x</a></div>');
    assert.equal(cleaned.element.querySelector("div")?.getAttribute("id"), "user-content-mc-body");
    assert.equal(cleaned.element.querySelector("a")?.getAttribute("name"), "user-content-body");
  });

  it("pins the remaining switches SPEC 6.3 depends on", () => {
    assert.equal(SANITIZER_CONFIG.ALLOW_DATA_ATTR, false);
    assert.equal(SANITIZER_CONFIG.ALLOW_UNKNOWN_PROTOCOLS, false);
    assert.equal(SANITIZER_CONFIG.RETURN_DOM_FRAGMENT, true);
    assert.equal(SANITIZER_CONFIG.SAFE_FOR_XML, true);
    assert.equal(SANITIZER_CONFIG.SANITIZE_DOM, true);
  });
});
