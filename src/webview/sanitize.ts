import createDOMPurify from "dompurify";
import type { Config, WindowLike } from "dompurify";

/** Where a blocked remote image parks its origin. Nothing reads it back as a source of truth:
 * re-enabling images is a fresh render whose `allowedOrigins` the host, not the mail, decides. */
export const REMOTE_IMAGE_ATTRIBUTE = "data-mc-remote";

/** SPEC 6.3, verbatim. The snapshot test in `test/sanitize` pins every entry. */
export const FORBIDDEN_TAGS: readonly string[] = Object.freeze([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "link",
  "meta",
  "base",
]);

/** Attributes that can never name a resource. DOMPurify tests every attribute it does not know to
 * be URI-free against `ALLOWED_URI_REGEXP`, and ours is `https:`/`mailto:` alone, so without this
 * list `bgcolor="#313640"`, `align="center"`, `colspan="2"` and `dir="rtl"` all fail it and a
 * newsletter loses the presentational markup HTML mail is built on. Every name here is already in
 * DOMPurify's own attribute allowlist, so this can only stop a URI check, never admit a new
 * attribute. Nothing that can point at a resource may be added: not href, src, srcset, action,
 * background, poster, cite, data, ping, longdesc, usemap or xlink:href. */
export const URI_FREE_ATTRIBUTES: readonly string[] = Object.freeze([
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "clear",
  "color",
  "colspan",
  "coords",
  "dir",
  "face",
  "headers",
  "height",
  "lang",
  "nowrap",
  "rowspan",
  "scope",
  "shape",
  "size",
  "span",
  "start",
  "type",
  "valign",
  "width",
]);

/** SPEC 6.3: `https` and `mailto`, and nothing else. */
export const ALLOWED_URI_REGEXP = /^(?:https:|mailto:)/i;

export const FORBIDDEN_EVENT_ATTRIBUTES: readonly string[] = Object.freeze([
  "onabort",
  "onafterprint",
  "onanimationend",
  "onanimationiteration",
  "onanimationstart",
  "onauxclick",
  "onbeforeinput",
  "onbeforematch",
  "onbeforeprint",
  "onbeforetoggle",
  "onbeforeunload",
  "onblur",
  "oncancel",
  "oncanplay",
  "oncanplaythrough",
  "onchange",
  "onclick",
  "onclose",
  "oncommand",
  "oncontentvisibilityautostatechange",
  "oncontextlost",
  "oncontextmenu",
  "oncontextrestored",
  "oncopy",
  "oncuechange",
  "oncut",
  "ondblclick",
  "ondrag",
  "ondragend",
  "ondragenter",
  "ondragleave",
  "ondragover",
  "ondragstart",
  "ondrop",
  "ondurationchange",
  "onemptied",
  "onended",
  "onerror",
  "onfocus",
  "onformdata",
  "onfullscreenchange",
  "onfullscreenerror",
  "ongotpointercapture",
  "onhashchange",
  "oninput",
  "oninvalid",
  "onkeydown",
  "onkeypress",
  "onkeyup",
  "onload",
  "onloadeddata",
  "onloadedmetadata",
  "onloadstart",
  "onlostpointercapture",
  "onmessage",
  "onmessageerror",
  "onmousedown",
  "onmouseenter",
  "onmouseleave",
  "onmousemove",
  "onmouseout",
  "onmouseover",
  "onmouseup",
  "onmousewheel",
  "onoffline",
  "ononline",
  "onpagehide",
  "onpagereveal",
  "onpageshow",
  "onpageswap",
  "onpaste",
  "onpause",
  "onplay",
  "onplaying",
  "onpointercancel",
  "onpointerdown",
  "onpointerenter",
  "onpointerleave",
  "onpointermove",
  "onpointerout",
  "onpointerover",
  "onpointerrawupdate",
  "onpointerup",
  "onpopstate",
  "onprogress",
  "onratechange",
  "onrejectionhandled",
  "onreset",
  "onresize",
  "onscroll",
  "onscrollend",
  "onscrollsnapchange",
  "onscrollsnapchanging",
  "onsecuritypolicyviolation",
  "onseeked",
  "onseeking",
  "onselect",
  "onselectionchange",
  "onselectstart",
  "onslotchange",
  "onstalled",
  "onstorage",
  "onsubmit",
  "onsuspend",
  "ontimeupdate",
  "ontoggle",
  "ontransitioncancel",
  "ontransitionend",
  "ontransitionrun",
  "ontransitionstart",
  "onunhandledrejection",
  "onunload",
  "onvolumechange",
  "onwaiting",
  "onwheel",
]);

/** `svg` itself is allowed, so the two elements that turn it into a fetch-and-include engine are
 * named here rather than left to DOMPurify's defaults. */
const FORBIDDEN_NAMESPACED_TAGS: ReadonlySet<string> = new Set(["use", "foreignobject"]);

const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set([
  REMOTE_IMAGE_ATTRIBUTE,
  "dynsrc",
  "formaction",
  "formtarget",
  "integrity",
  "lowsrc",
  "nonce",
  "ping",
  "srcset",
  "target",
  "xlink:actuate",
  "xlink:href",
  "xlink:show",
]);

/** Legacy remote-image carriers. Counted like an `img src`, then dropped. */
const REMOTE_MEDIA_ATTRIBUTES: ReadonlySet<string> = new Set(["background", "poster"]);

/** Elements whose source the image policy governs, so a per-message allow can legitimately load
 * them. Media elements are absent: no `media-src` is ever granted, so their sources are simply
 * dropped rather than counted as images the user could choose to load. */
const IMAGE_SOURCE_TAGS: ReadonlySet<string> = new Set(["image", "img", "input"]);
const MEDIA_TAGS: ReadonlySet<string> = new Set(["audio", "source", "track", "video"]);
const ANCHOR_TAGS: ReadonlySet<string> = new Set(["a", "area"]);

const IMAGE_SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src"]);
const DOCUMENT_FRAGMENT_NODE = 11;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const CID_SCHEME = /^cid:/i;

/** Only the four types `src/reader/inlineImages.ts` is willing to mint. SVG is absent on purpose:
 * an inline SVG image is a document, and the CSP is the only thing between it and a fetch. */
const INLINE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/i;

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
/** A CSS escape: `\` then one to six hex digits and an optional trailing space, or `\` then any
 * single character that is not a newline. Decoded before every other pattern runs, because the
 * browser decodes them too and `u\72l(` is `url(`. */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\r\n\f0-9a-f]))/gi;
const CSS_IMPORT = /@import[^;}]*(?:;|$)/gi;
const CSS_IMPORT_TARGET = /(?:url\(\s*)?["']?\s*(https:\/\/[^"')\s]+)/i;
const CSS_EXPRESSION = /expression\s*\(/gi;
const CSS_BINDING = /(?:-moz-binding|behavior)\s*:[^;}]*/gi;
const CSS_IMPORTANT = /!\s*important/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
/** Every other CSS function that can take a URL. `url()` is handled first so that a `data:` image
 * inside one of these still counts as remote for the census: the whole call becomes `none`. */
const CSS_FETCH_FUNCTION = /(?<![\w-])(?:-webkit-|-moz-|-o-|-ms-)?(?:src|image|image-set|cross-fade|element)\s*\(/gi;
const CSS_REMOTE_REFERENCE = /https:\/\/[^"')\s,]+/gi;
/** The mail is mounted in a shadow root; `:host` is the one selector that could reach out of it. */
const CSS_HOST_SELECTOR = /:host(?:-context)?(?![\w-])/gi;
/** A `body` selector matches nothing inside a shadow root; the wrapper the reader mounts the mail in
 * stands in for it, which is what keeps a newsletter's page background. */
const CSS_BODY_SELECTOR = /(?<![\w.#:-])body(?=[\s{,.#[:>+~])/gi;
const MAIL_WRAPPER_SELECTOR = ".mc-mail";
/** Anything with a scheme and an authority that survived the passes above. Base64 cannot contain
 * a colon, so a kept `data:image/...` URI never matches. */
const CSS_ANY_SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/[^"')\s,;}]*/gi;

export interface RemoteImageCensus {
  /** How many remote image references were blocked, counting repeats. */
  readonly blocked: number;
  /** The distinct `https://host[:port]` origins behind them, in first-seen order. */
  readonly origins: readonly string[];
}

export interface SanitizeRequest {
  /** `cid` → `data:` URI, minted by the host from the message's own inline parts. Trusted. */
  readonly inlineImages: Readonly<Record<string, string>>;
  /** Origins the host has already widened the image policy to, for this one render. */
  readonly allowedOrigins: readonly string[];
}

export interface SanitizedBody {
  readonly fragment: DocumentFragment;
  readonly census: RemoteImageCensus;
}

export interface BodySanitizer {
  sanitize(html: string, request?: SanitizeRequest): SanitizedBody;
  /** The effective DOMPurify configuration, for the test that pins SPEC 6.3. */
  readonly config: Readonly<Config>;
}

export const SANITIZER_CONFIG: Readonly<Config> = Object.freeze({
  FORBID_TAGS: FORBIDDEN_TAGS as string[],
  FORBID_ATTR: FORBIDDEN_EVENT_ATTRIBUTES as string[],
  ALLOWED_URI_REGEXP,
  ADD_URI_SAFE_ATTR: URI_FREE_ATTRIBUTES as string[],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
  SAFE_FOR_XML: true,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  ALLOW_SELF_CLOSE_IN_ATTR: false,
  FORCE_BODY: true,
});

const NO_REQUEST: SanitizeRequest = { inlineImages: {}, allowedOrigins: [] };

function tagNameOf(node: Node): string {
  return node.nodeName.toLowerCase();
}

/** `new URL` refuses a relative reference, which is what makes a scheme-relative `//host/x`
 * and a bare `/pixel.gif` fall out here rather than resolve against the webview's own origin. */
function httpsOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" ? url.origin : undefined;
}

function isFragment(value: unknown): value is DocumentFragment {
  return typeof value === "object" && value !== null && (value as Node).nodeType === DOCUMENT_FRAGMENT_NODE;
}

function inlineImageFor(images: Readonly<Record<string, string>>, cid: string): string | undefined {
  if (cid === "" || !Object.hasOwn(images, cid)) {
    return undefined;
  }
  const source = images[cid];
  return typeof source === "string" && INLINE_DATA_IMAGE.test(source) ? source : undefined;
}

/** The CSP is what stops remote CSS loading; this pass keeps the violation counter at zero and
 * lands a remote `background-image` in the blocked total. `!important` goes too, or mail CSS
 * outranks the reader's chrome and can hide the very bar that reports the blocking. */
export function filterCss(css: string, report: (origin: string) => void): string {
  const filtered = decodeCssEscapes(css.replace(CSS_COMMENT, ""))
    .replace(CSS_IMPORT, (match: string) => {
      const target = CSS_IMPORT_TARGET.exec(match);
      const origin = target === null ? undefined : httpsOrigin(target[1] ?? "");
      if (origin !== undefined) {
        report(origin);
      }
      return "";
    })
    .replace(CSS_EXPRESSION, "")
    .replace(CSS_BINDING, "")
    .replace(CSS_IMPORTANT, "")
    .replace(CSS_URL, (match, quoted: string | undefined, single: string | undefined, bare: string | undefined) => {
      const argument = (quoted ?? single ?? bare ?? "").trim();
      if (INLINE_DATA_IMAGE.test(argument) || argument.toLowerCase().startsWith("data:image/")) {
        return match;
      }
      const origin = httpsOrigin(argument);
      if (origin !== undefined) {
        report(origin);
      }
      return "none";
    });
  return replaceFetchFunctions(filtered, report)
    .replace(CSS_ANY_SCHEME_URL, "")
    .replace(CSS_HOST_SELECTOR, ":not(*)")
    .replace(CSS_BODY_SELECTOR, MAIL_WRAPPER_SELECTOR);
}

function decodeCssEscapes(css: string): string {
  return css.replace(CSS_ESCAPE, (_match, hex: string | undefined, literal: string | undefined) => {
    if (hex === undefined) {
      return literal ?? "";
    }
    const codePoint = Number.parseInt(hex, 16);
    const replaceable = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
    return String.fromCodePoint(replaceable ? 0xfffd : codePoint);
  });
}

/** Walks to the parenthesis that closes each fetch-capable call, honouring nesting and quoted
 * strings, so `image-set(url(a) 1x, "b" 2x)` is replaced as one unit rather than left half-open. */
function replaceFetchFunctions(css: string, report: (origin: string) => void): string {
  let out = "";
  let cursor = 0;
  CSS_FETCH_FUNCTION.lastIndex = 0;
  for (let call = CSS_FETCH_FUNCTION.exec(css); call !== null; call = CSS_FETCH_FUNCTION.exec(css)) {
    const open = call.index + call[0].length;
    const close = closingParenthesis(css, open);
    for (const reference of css.slice(open, close).match(CSS_REMOTE_REFERENCE) ?? []) {
      const origin = httpsOrigin(reference);
      if (origin !== undefined) {
        report(origin);
      }
    }
    out += css.slice(cursor, call.index) + "none";
    cursor = Math.min(close + 1, css.length);
    CSS_FETCH_FUNCTION.lastIndex = cursor;
  }
  return out + css.slice(cursor);
}

function closingParenthesis(css: string, open: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (let index = open; index < css.length; index++) {
    const char = css[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && --depth === 0) {
      return index;
    }
  }
  return css.length;
}

function filterStyleElement(element: Element, report: (origin: string) => void): void {
  for (const child of Array.from(element.childNodes)) {
    const text = child.nodeValue;
    if (child.nodeType === TEXT_NODE && typeof text === "string") {
      child.nodeValue = filterCss(text, report);
    }
  }
}

/** A second sweep over the finished fragment. Everything here is already handled by a hook; this
 * is the belt to that braces, and it is also where CSS text split across sibling text nodes gets
 * seen as one string. */
function reharden(fragment: DocumentFragment, report: (origin: string) => void): void {
  for (const element of Array.from(fragment.querySelectorAll("*"))) {
    const tag = element.localName.toLowerCase();
    if (FORBIDDEN_TAGS.includes(tag) || FORBIDDEN_NAMESPACED_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || DROPPED_ATTRIBUTES.has(name)) {
        if (name !== REMOTE_IMAGE_ATTRIBUTE) {
          element.removeAttribute(attribute.name);
        }
      } else if (name === "src" && MEDIA_TAGS.has(tag)) {
        element.removeAttribute(attribute.name);
      } else if (name === "href" && !ANCHOR_TAGS.has(tag) && !IMAGE_SOURCE_TAGS.has(tag)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (tag === "style") {
      filterStyleElement(element, report);
      continue;
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      const filtered = filterCss(style, report);
      if (filtered !== style) {
        element.setAttribute("style", filtered);
      }
    }
  }
}

export function createSanitizer(window: WindowLike): BodySanitizer {
  const purify = createDOMPurify(window);
  const document = window.document;
  if (!purify.isSupported || document === undefined) {
    throw new Error("This runtime cannot sanitise HTML, so no HTML may be rendered in it.");
  }

  let request: SanitizeRequest = NO_REQUEST;
  let allowed: ReadonlySet<string> = new Set();
  let blocked = 0;
  let origins: string[] = [];
  let seen: Set<string> = new Set();
  let pendingRemote: string | undefined;

  const report = (origin: string): void => {
    blocked += 1;
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  };

  purify.addHook("uponSanitizeElement", (node, event) => {
    if (FORBIDDEN_NAMESPACED_TAGS.has(event.tagName)) {
      event.allowedTags[event.tagName] = false;
      return;
    }
    if (node.nodeType === ELEMENT_NODE && event.tagName === "style") {
      filterStyleElement(node as Element, report);
    }
  });

  purify.addHook("beforeSanitizeAttributes", () => {
    pendingRemote = undefined;
  });

  purify.addHook("uponSanitizeAttribute", (node, event) => {
    const name = event.attrName;
    if (name.startsWith("on") || DROPPED_ATTRIBUTES.has(name)) {
      event.keepAttr = false;
      return;
    }

    if (name === "style") {
      event.attrValue = filterCss(event.attrValue, report);
      return;
    }

    if (REMOTE_MEDIA_ATTRIBUTES.has(name)) {
      const origin = httpsOrigin(event.attrValue);
      if (origin !== undefined) {
        report(origin);
      }
      event.keepAttr = false;
      return;
    }

    const tag = tagNameOf(node);
    if (MEDIA_TAGS.has(tag) && name === "src") {
      event.keepAttr = false;
      return;
    }
    if (name === "href" && !ANCHOR_TAGS.has(tag) && !IMAGE_SOURCE_TAGS.has(tag)) {
      event.keepAttr = false;
      return;
    }
    if (!IMAGE_SOURCE_TAGS.has(tag) || !IMAGE_SOURCE_ATTRIBUTES.has(name)) {
      return;
    }

    const value = event.attrValue;
    if (CID_SCHEME.test(value)) {
      const source = inlineImageFor(request.inlineImages, value.slice("cid:".length));
      if (source === undefined) {
        event.keepAttr = false;
        return;
      }
      event.attrValue = source;
      return;
    }

    const origin = httpsOrigin(value);
    if (origin === undefined) {
      event.keepAttr = false;
      return;
    }
    if (allowed.has(origin)) {
      return;
    }
    report(origin);
    pendingRemote = origin;
    event.keepAttr = false;
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    if (pendingRemote === undefined) {
      return;
    }
    node.setAttribute(REMOTE_IMAGE_ATTRIBUTE, pendingRemote);
    pendingRemote = undefined;
  });

  return {
    config: SANITIZER_CONFIG,
    sanitize(html: string, next: SanitizeRequest = NO_REQUEST): SanitizedBody {
      request = next;
      allowed = new Set(next.allowedOrigins);
      blocked = 0;
      origins = [];
      seen = new Set();
      pendingRemote = undefined;

      // DOMPurify answers null, not an empty fragment, when the parse yields no body (a frameset).
      const result: unknown = purify.sanitize(html, { ...SANITIZER_CONFIG, RETURN_DOM_FRAGMENT: true });
      const fragment = isFragment(result) ? result : document.createDocumentFragment();
      reharden(fragment, report);

      const census: RemoteImageCensus = { blocked, origins: [...origins] };
      request = NO_REQUEST;
      allowed = new Set();
      return { fragment, census };
    },
  };
}
