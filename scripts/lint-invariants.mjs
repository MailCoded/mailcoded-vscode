#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(REPO_ROOT, "src");
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const HTML_ACCESSOR_FILE = "daemon/client.ts";
const HTML_ACCESSOR = "getMessageHtmlForWebview";
const CSP_FILE = "reader/shell.ts";

const RULES = [
  {
    pattern: /window\.createTerminal/,
    message: "no terminals: mail content must never reach a shell",
  },
  {
    pattern: /\.trace\(/,
    message: "JSON-RPC tracing stays off: params carry credentials and confirm tokens",
  },
  {
    pattern: /\beval\s*\(/,
    message: "no eval anywhere in the client",
  },
  {
    pattern: /confirmToken/,
    message: "confirm tokens belong to src/compose/ and src/protocol/ only",
    allow: (file) => file.startsWith("compose/") || file.startsWith("protocol/"),
  },
  {
    pattern: /request\(\s*"search"/,
    message: "call searchMessages() instead: it is what clamps the limit, and search is never unbounded",
    allow: (file) => file === "daemon/client.ts",
  },
  {
    pattern: /format:\s*(MessageFormats\.Raw|"raw")/,
    message: "nothing in this client asks message.get for 'raw'",
  },
  {
    pattern: /MessageFormats\.Html|format:\s*"html"/,
    message:
      "message.get asks for 'text' everywhere but getMessageHtmlForWebview() in src/daemon/client.ts; " +
      "bodyHtml renders in the sandboxed webview or nowhere",
    allow: (file) => file === HTML_ACCESSOR_FILE,
  },
  {
    pattern: /default-src|img-src/,
    message: "the CSP is written once, in src/reader/shell.ts (engine SPEC.md 6.3); a second one would not be reviewed",
    allow: (file) => file === CSP_FILE,
  },
];

function sourceFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => EXTENSIONS.has(path.extname(entry)))
    .filter((entry) => statSync(path.join(root, entry)).isFile())
    .sort();
}

const files = sourceFiles(SRC);
const violations = [];

for (const file of files) {
  const lines = readFileSync(path.join(SRC, file), "utf8").split(/\r?\n/);
  for (const rule of RULES) {
    if (rule.allow?.(file)) continue;
    lines.forEach((text, index) => {
      if (rule.pattern.test(text)) {
        violations.push(`src/${file}:${index + 1}: ${rule.message}\n    ${text.trim()}`);
      }
    });
  }
}


// 'html' is allowed at exactly one call site. A second mention in the same file would be a second,
// possibly unsandboxed, path to raw bodyHtml, which the file-level allowance above cannot see.
const accessorFile = files.includes(HTML_ACCESSOR_FILE)
  ? readFileSync(path.join(SRC, HTML_ACCESSOR_FILE), "utf8")
  : "";
const htmlSites = [...accessorFile.matchAll(/MessageFormats\.Html|format:\s*"html"/g)].length;
if (htmlSites > 1) {
  violations.push(
    `src/${HTML_ACCESSOR_FILE}: ${htmlSites} call sites ask message.get for 'html'; exactly one, ${HTML_ACCESSOR}(), is permitted`,
  );
}
if (htmlSites === 1 && !new RegExp(`${HTML_ACCESSOR}[\\s\\S]{0,400}?MessageFormats\\.Html`).test(accessorFile)) {
  violations.push(
    `src/${HTML_ACCESSOR_FILE}: the 'html' request is not inside ${HTML_ACCESSOR}(), the only accessor the webview path may reach`,
  );
}

// A command declared in the manifest is invokable from the palette, so one without a
// registerCommand call fails at the click with "command not found".
const manifest = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
const nls = JSON.parse(readFileSync(path.join(SRC, "..", "package.nls.json"), "utf8"));
const contributes = manifest.contributes ?? {};

const declared = new Set((contributes.commands ?? []).map((entry) => entry.command));
const registered = new Set();
for (const file of files) {
  const text = readFileSync(path.join(SRC, file), "utf8");
  for (const match of text.matchAll(/registerCommand\(\s*([A-Za-z0-9_]+|"[^"]+")/g)) {
    const token = match[1];
    if (token.startsWith('"')) {
      registered.add(token.slice(1, -1));
      continue;
    }
    const constant = text.match(new RegExp(`${token}\\s*=\\s*"([^"]+)"`));
    if (constant) registered.add(constant[1]);
  }
}

for (const command of declared) {
  if (!registered.has(command)) {
    violations.push(`package.json: '${command}' is declared but never registered; the palette would offer a command that fails`);
  }
}

const referenced = new Set();
for (const entries of Object.values(contributes.menus ?? {})) {
  for (const entry of entries) if (entry.command) referenced.add(entry.command);
}
for (const entry of contributes.keybindings ?? []) referenced.add(entry.command);
for (const welcome of contributes.viewsWelcome ?? []) {
  const body = nls[String(welcome.contents).replace(/%/g, "")] ?? welcome.contents;
  for (const match of String(body).matchAll(/command:([A-Za-z0-9_.]+)/g)) referenced.add(match[1]);
}
for (const command of referenced) {
  if (command.startsWith("mailcoded.") && !declared.has(command)) {
    violations.push(`package.json: a menu or welcome view points at '${command}', which is not declared`);
  }
}

process.stdout.write(`Scanned ${files.length} source file(s) under src/ for ${RULES.length} invariant(s), and the manifest against ${registered.size} registered command(s)\n`);

if (violations.length > 0) {
  process.stderr.write(`\n${violations.join("\n")}\n\n${violations.length} invariant violation(s)\n`);
  process.exit(1);
}
