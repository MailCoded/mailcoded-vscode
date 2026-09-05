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

process.stdout.write(`Scanned ${files.length} source file(s) under src/ for ${RULES.length} invariant(s)\n`);

if (violations.length > 0) {
  process.stderr.write(`\n${violations.join("\n")}\n\n${violations.length} invariant violation(s)\n`);
  process.exit(1);
}
