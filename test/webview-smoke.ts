/* Drives the built webview bundle in a real Chromium under the real shell and CSP, without VS Code.
 * Every check runs inside the page; the page writes its verdicts into the DOM and Chromium dumps it. */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { READER_STYLES, buildShell, createNonce } from "../src/reader/shell.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = path.join(ROOT, "dist", "webview", "main.js");
const FIXTURES = path.join(ROOT, "test", "fixtures", "html");
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PLACEHOLDER_SCRIPT = "vscode-file://smoke/main.js";
const BUDGET_MS = 20000;

interface SmokeCase {
  readonly name: string;
  readonly mode?: "html" | "text";
  readonly bodyHtml?: string;
  readonly bodyText?: string;
  readonly inlineImages?: Record<string, string>;
  readonly check?: string;
}

interface Verdict {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface CaseResult {
  readonly name: string;
  readonly verdicts: readonly Verdict[];
}

function chromium(): string | undefined {
  const fromEnv = process.env["CHROMIUM"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0) {
      return found.stdout.trim();
    }
  }
  return undefined;
}

const fixtureCases: SmokeCase[] = readdirSync(FIXTURES)
  .filter((entry) => entry.endsWith(".html"))
  .sort()
  .map((entry) => {
    const check = entry.startsWith("002") ? "blocks-one-tracker" : entry.startsWith("016") ? "inline-image-loads" : undefined;
    return {
      name: `fixture ${entry}`,
      bodyHtml: readFileSync(path.join(FIXTURES, entry), "utf8"),
      inlineImages: { "logo016@example.com": PIXEL },
      ...(check === undefined ? {} : { check }),
    };
  });

const cases: SmokeCase[] = [
  ...fixtureCases,
  {
    name: "mail CSS cannot hide the chrome",
    bodyHtml:
      "<style>button,span,div,#mc-toolbar,#mc-banner,.mc-blocked{display:none !important;visibility:hidden}</style>" +
      '<img src="https://t.example/x.gif"><p>x</p>',
    check: "chrome-survives",
  },
  {
    name: "position: fixed stays inside the body",
    bodyHtml:
      '<div id="overlay" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:red">x</div><p>y</p>',
    check: "fixed-overlay-contained",
  },
  {
    name: "a mail stylesheet applies inside the shadow root",
    bodyHtml: '<style>.z{color:rgb(1,2,3)} body{background:rgb(9,8,7)}</style><p class="z">x</p>',
    check: "mail-style-applies",
  },
  {
    name: "the reader's own mail stylesheet applies",
    bodyHtml: '<a href="https://ok.example/x">l</a><img src="https://r.example/i.png">',
    check: "reader-style-applies",
  },
  {
    name: "CSS escape and image-set bypasses",
    bodyHtml:
      '<div id="e1" style="background:u\\72l(https://evil.example/a.gif)">a</div>' +
      '<div id="e2" style="background:image-set(\'https://evil2.example/a.png\' 1x)">b</div>' +
      '<style>@\\69mport "https://evil3.example/x.css";</style>',
    check: "bypasses-neutralised",
  },
  {
    name: ":host cannot restyle the container",
    bodyHtml: "<style>:host{display:none;position:fixed}</style><p>x</p>",
    check: "host-neutralised",
  },
  {
    name: "script and handlers are gone",
    bodyHtml: '<script>document.title="pwned"</script><img src="x" onerror="document.title=\'pwned\'"><svg onload="document.title=\'pwned\'"></svg><p>x</p>',
    check: "nothing-ran",
  },
  {
    name: "a link click inside the shadow root reaches the host",
    bodyHtml: '<p><a href="https://ok.example/x"><b>deep</b></a></p>',
    check: "click-link",
  },
  {
    name: "plain text mode",
    mode: "text",
    bodyText: "see https://ok.example/t\n<b>not bold</b>",
    check: "text-mode",
  },
];

const DRIVER = String.raw`
(async () => {
  const results = [];
  const publish = () => {
    const out = document.createElement("pre");
    out.id = "mc-smoke";
    out.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(results))));
    document.body.append(out);
  };
  window.addEventListener("error", (event) => {
    results.push({ name: "driver", verdicts: [{ check: "uncaught error", ok: false, detail: String(event.message) }] });
  });
  const watchdog = setTimeout(() => {
    results.push({ name: "driver", verdicts: [{ check: "finished in time", ok: false, detail: "watchdog fired" }] });
    publish();
  }, 12000);
  try {
  const cases = JSON.parse(document.getElementById("mc-cases").textContent);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const body = () => document.getElementById("mc-body");
  const mail = () => body().shadowRoot;
  const wrapper = () => mail() && mail().querySelector(".mc-mail");
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const postsSince = (index) => window.__posts.slice(index);
  const checks = {
    "blocks-one-tracker": (posts) => {
      const blocked = posts.find((p) => p.type === "blockedImages");
      return [{ check: "census", ok: !!blocked && blocked.count === 1 && blocked.origins.join() === "https://tracker.example.net", detail: JSON.stringify(blocked) }];
    },
    "inline-image-loads": async () => {
      const img = mail().querySelector("img");
      const decoded = img
        ? await Promise.race([img.decode().then(() => "decoded", (e) => "rejected: " + e), wait(500).then(() => "timed out")])
        : "no img";
      return [
        { check: "img has data: src", ok: !!img && img.getAttribute("src").startsWith("data:image/gif"), detail: img ? img.getAttribute("src").slice(0, 30) : "no img" },
        { check: "img loaded under img-src data:", ok: !!img && img.complete && img.naturalWidth === 1, detail: decoded + " complete=" + (img && img.complete) + " naturalWidth=" + (img && img.naturalWidth) },
      ];
    },
    "chrome-survives": () => {
      const toolbar = [...document.querySelectorAll("#mc-toolbar button")];
      const bannerButton = document.querySelector("#mc-banner button");
      const headerSpans = [...document.querySelectorAll("#mc-header span")];
      return [
        { check: "toolbar buttons visible", ok: toolbar.length === 2 && toolbar.every(visible), detail: toolbar.map((b) => getComputedStyle(b).display).join(",") },
        { check: "banner button visible", ok: visible(bannerButton), detail: bannerButton ? getComputedStyle(bannerButton).display : "no button" },
        { check: "header visible", ok: headerSpans.length > 0 && headerSpans.every(visible), detail: String(headerSpans.length) },
        { check: "mail p hidden by its own rule", ok: !visible(mail().querySelector("p")), detail: getComputedStyle(mail().querySelector("p")).display },
      ];
    },
    "fixed-overlay-contained": () => {
      const overlay = mail().querySelector("div[style*=fixed]");
      const rect = overlay.getBoundingClientRect();
      const host = body().getBoundingClientRect();
      const toolbar = document.getElementById("mc-toolbar").getBoundingClientRect();
      return [
        { check: "overlay top at body top", ok: Math.abs(rect.top - host.top) < 1.5, detail: rect.top + " vs " + host.top },
        { check: "overlay below toolbar", ok: rect.top >= toolbar.bottom - 0.5, detail: rect.top + " vs toolbar bottom " + toolbar.bottom },
        { check: "toolbar hit-test unobstructed", ok: document.elementFromPoint(toolbar.left + 5, toolbar.top + 5)?.closest("#mc-toolbar") !== null, detail: String(document.elementFromPoint(toolbar.left + 5, toolbar.top + 5)?.id) },
      ];
    },
    "mail-style-applies": () => {
      const p = mail().querySelector("p.z");
      return [
        { check: "color from mail <style>", ok: getComputedStyle(p).color === "rgb(1, 2, 3)", detail: getComputedStyle(p).color },
        { check: "body rule reaches wrapper", ok: getComputedStyle(wrapper()).backgroundColor === "rgb(9, 8, 7)", detail: getComputedStyle(wrapper()).backgroundColor },
        { check: "document body untouched", ok: getComputedStyle(document.body).backgroundColor !== "rgb(9, 8, 7)", detail: getComputedStyle(document.body).backgroundColor },
      ];
    },
    "reader-style-applies": () => {
      const a = mail().querySelector("a");
      const img = mail().querySelector("img");
      return [
        { check: "anchor underlined", ok: getComputedStyle(a).textDecorationLine.includes("underline"), detail: getComputedStyle(a).textDecorationLine },
        { check: "blocked img outlined", ok: getComputedStyle(img).outlineStyle === "dashed", detail: getComputedStyle(img).outlineStyle },
        { check: "blocked img has no src", ok: !img.hasAttribute("src") && img.getAttribute("data-mc-remote") === "https://r.example", detail: img.outerHTML.slice(0, 80) },
      ];
    },
    "bypasses-neutralised": (posts) => {
      const e1 = mail().querySelector("#user-content-e1") || mail().querySelectorAll("div")[0];
      const e2 = mail().querySelectorAll("div")[1];
      const blocked = posts.find((p) => p.type === "blockedImages");
      return [
        { check: "u\\72l() background none", ok: getComputedStyle(e1).backgroundImage === "none", detail: getComputedStyle(e1).backgroundImage },
        { check: "image-set() background none", ok: getComputedStyle(e2).backgroundImage === "none", detail: getComputedStyle(e2).backgroundImage },
        { check: "all three counted", ok: !!blocked && blocked.origins.join() === "https://evil.example,https://evil2.example,https://evil3.example", detail: JSON.stringify(blocked) },
      ];
    },
    "host-neutralised": () => [
      { check: "container still displayed", ok: getComputedStyle(body()).display !== "none", detail: getComputedStyle(body()).display },
      { check: "container not fixed", ok: getComputedStyle(body()).position !== "fixed", detail: getComputedStyle(body()).position },
    ],
    "nothing-ran": () => [
      { check: "title untouched", ok: document.title !== "pwned", detail: document.title },
      { check: "no script in shadow", ok: mail().querySelectorAll("script").length === 0, detail: "" },
      { check: "no handlers in shadow", ok: ![...mail().querySelectorAll("*")].some((e) => [...e.attributes].some((a) => a.name.startsWith("on"))), detail: "" },
    ],
    "click-link": async () => {
      const before = window.__posts.length;
      const b = mail().querySelector("b");
      const cancelled = !b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
      await wait(20);
      const posts = postsSince(before);
      return [
        { check: "navigation cancelled", ok: cancelled, detail: String(cancelled) },
        { check: "openLink posted", ok: posts.some((p) => p.type === "openLink" && p.href === "https://ok.example/x"), detail: JSON.stringify(posts) },
        { check: "still on the page", ok: location.href.startsWith("file:"), detail: location.href.slice(0, 20) },
      ];
    },
    "text-mode": () => {
      const pre = mail().querySelector("pre");
      return [
        { check: "pre present", ok: !!pre, detail: "" },
        { check: "markup shown as text", ok: pre.textContent.includes("<b>not bold</b>") && pre.querySelectorAll("b").length === 0, detail: pre.textContent.slice(0, 40) },
        { check: "https autolinked", ok: pre.querySelectorAll("a").length === 1, detail: String(pre.querySelectorAll("a").length) },
      ];
    },
  };

  await wait(50);
  const readyPosted = window.__posts.some((p) => p.type === "ready");
  results.push({ name: "bundle", verdicts: [{ check: "ready posted", ok: readyPosted, detail: JSON.stringify(window.__posts) }] });

  let id = 100;
  for (const c of cases) {
    id += 1;
    const from = window.__posts.length;
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "render", messageId: id, mode: c.mode || "html",
      header: { subject: "Smoke", from: "a@example.com", to: "b@example.com", date: "2026-09-07 22:00", tags: [] },
      attachments: [], inlineImages: c.inlineImages || {}, allowedOrigins: [],
      ...(c.bodyHtml === undefined ? {} : { bodyHtml: c.bodyHtml }),
      ...(c.bodyText === undefined ? {} : { bodyText: c.bodyText }),
    } }));
    await wait(150);
    const posts = postsSince(from);
    const verdicts = [
      { check: "rendered", ok: posts.some((p) => p.type === "rendered" && p.messageId === id), detail: JSON.stringify(posts.map((p) => p.type)) },
      { check: "zero CSP violations", ok: !posts.some((p) => p.type === "cspViolation"), detail: JSON.stringify(posts.filter((p) => p.type === "cspViolation")) },
      { check: "mounted in a shadow root", ok: !!mail() && !!wrapper(), detail: String(!!mail()) },
      { check: "no mail <style> in the document", ok: document.querySelectorAll("style").length === 2, detail: String(document.querySelectorAll("style").length) },
      { check: "status line clear", ok: (document.querySelector(".mc-status")?.textContent ?? "") === "", detail: document.querySelector(".mc-status")?.textContent ?? "" },
    ];
    if (c.check) {
      try {
        verdicts.push(...(await checks[c.check](posts)));
      } catch (error) {
        verdicts.push({ check: c.check, ok: false, detail: "threw: " + String(error && error.message || error) });
      }
    }
    results.push({ name: c.name, verdicts });
  }
  } catch (error) {
    results.push({ name: "driver", verdicts: [{ check: "completed", ok: false, detail: "threw: " + String(error && error.message || error) }] });
  }
  clearTimeout(watchdog);
  publish();
})();
`;

function main(): number {
  const browser = chromium();
  if (browser === undefined) {
    console.log("smoke:webview skipped: no Chromium found (set CHROMIUM to a binary).");
    return 0;
  }
  if (!existsSync(BUNDLE)) {
    execFileSync("node", [path.join(ROOT, "esbuild.mjs")], { stdio: "inherit" });
  }

  const work = mkdtempSync(path.join(tmpdir(), "mailcoded-webview-smoke-"));
  for (const dir of ["home", "xdg", "cache", "profile"]) {
    mkdirSync(path.join(work, dir));
  }
  copyFileSync(BUNDLE, path.join(work, "main.js"));

  const nonce = createNonce();
  const shell = buildShell({
    nonce,
    cspSource: "'self' https://*.vscode-cdn.net",
    scriptUri: PLACEHOLDER_SCRIPT,
    styles: READER_STYLES,
  });
  const mainTag = `<script nonce="${nonce}" src="${PLACEHOLDER_SCRIPT}"></script>`;
  if (!shell.includes(mainTag)) {
    throw new Error("The shell no longer emits the script tag this harness expects.");
  }
  const page = shell.replace(
    mainTag,
    [
      `<script nonce="${nonce}">window.__posts=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__posts.push(m)}});</script>`,
      `<script type="application/json" id="mc-cases">${JSON.stringify(cases).replaceAll("<", "\\u003c")}</script>`,
      `<script nonce="${nonce}" src="./main.js"></script>`,
      `<script nonce="${nonce}">${DRIVER}</script>`,
    ].join("\n"),
  );
  const pagePath = path.join(work, "index.html");
  writeFileSync(pagePath, page);

  const run = spawnSync(
    browser,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--no-first-run",
      "--window-size=1000,1400",
      `--user-data-dir=${path.join(work, "profile")}`,
      `--virtual-time-budget=${String(BUDGET_MS)}`,
      "--dump-dom",
      `file://${pagePath}`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
      env: {
        ...process.env,
        HOME: path.join(work, "home"),
        XDG_CONFIG_HOME: path.join(work, "xdg"),
        XDG_CACHE_HOME: path.join(work, "cache"),
      },
    },
  );
  const match = /<pre id="mc-smoke">([A-Za-z0-9+/=]+)<\/pre>/.exec(run.stdout);
  if (match === null) {
    console.error(run.stderr.split("\n").filter((line) => !line.startsWith("[")).join("\n"));
    console.error(`smoke:webview: Chromium exited ${String(run.status)} and the page wrote no verdicts.`);
    console.error(run.stdout.slice(0, 2000));
    return 1;
  }
  const results = JSON.parse(decodeURIComponent(escape(Buffer.from(match[1] ?? "", "base64").toString("latin1")))) as CaseResult[];

  let failures = 0;
  for (const result of results) {
    const failed = result.verdicts.filter((verdict) => !verdict.ok);
    failures += failed.length;
    console.log(`${failed.length === 0 ? "ok  " : "FAIL"} ${result.name}`);
    for (const verdict of failed) {
      console.log(`       ✗ ${verdict.check}: ${verdict.detail}`);
    }
  }
  const total = results.reduce((sum, result) => sum + result.verdicts.length, 0);
  console.log(`\n${String(total - failures)}/${String(total)} checks passed in ${browser}`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
