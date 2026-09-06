#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(REPO_ROOT, "src");
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

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
