#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_DIR = path.resolve(REPO_ROOT, process.env.MAILCODED_ENGINE_DIR ?? "../mailcoded");
const RELATIVE_SOURCE = "packages/protocol/src/generated.ts";
const SOURCE = path.join(ENGINE_DIR, ...RELATIVE_SOURCE.split("/"));
const TARGET = path.join(REPO_ROOT, "src", "protocol", "generated.ts");
const MARKER = "// mailcoded-sync:";

const check = process.argv.includes("--check");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function engineCommit() {
  try {
    return execFileSync("git", ["-C", ENGINE_DIR, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function stripHeader(text) {
  const lines = normalize(text).split("\n");
  while (lines.length > 0 && lines[0].startsWith(MARKER)) lines.shift();
  if (lines.length > 0 && lines[0] === "") lines.shift();
  return lines.join("\n");
}

if (!existsSync(SOURCE)) {
  fail(
    `Engine protocol types not found at ${SOURCE}\n` +
      "Set MAILCODED_ENGINE_DIR to the mailcoded checkout, or clone it beside this repository.",
  );
}

const body = normalize(readFileSync(SOURCE, "utf8"));

if (check) {
  if (!existsSync(TARGET)) fail("Protocol drift: src/protocol/generated.ts is missing. Run npm run sync:protocol");
  if (stripHeader(readFileSync(TARGET, "utf8")) !== body) {
    fail(
      `Protocol drift: src/protocol/generated.ts differs from ${ENGINE_DIR}/${RELATIVE_SOURCE}\n` +
        "Run npm run sync:protocol and commit the result.",
    );
  }
  process.stdout.write(`src/protocol/generated.ts matches ${RELATIVE_SOURCE}\n`);
  process.exit(0);
}

const commit = engineCommit();
const header =
  `${MARKER} copied from mailcoded ${RELATIVE_SOURCE} @ ${commit}\n` +
  `${MARKER} do not edit; run npm run sync:protocol\n\n`;

mkdirSync(path.dirname(TARGET), { recursive: true });
writeFileSync(TARGET, header + body);
process.stdout.write(`Wrote src/protocol/generated.ts from mailcoded @ ${commit} (${body.split("\n").length} lines)\n`);
