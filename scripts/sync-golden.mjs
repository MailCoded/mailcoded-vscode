#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_DIR = path.resolve(REPO_ROOT, process.env.MAILCODED_ENGINE_DIR ?? "../mailcoded");
const RELATIVE_SOURCE = "tests/Mailcoded.Core.Tests/golden";
const SOURCE = path.join(ENGINE_DIR, ...RELATIVE_SOURCE.split("/"));
const TARGET = path.join(REPO_ROOT, "test", "fixtures", "golden");

const check = process.argv.includes("--check");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

if (!existsSync(SOURCE)) {
  fail(
    `Engine golden transcripts not found at ${SOURCE}\n` +
      "Set MAILCODED_ENGINE_DIR to the mailcoded checkout, or clone it beside this repository.",
  );
}

const names = readdirSync(SOURCE)
  .filter((name) => name.endsWith(".json"))
  .sort();

if (names.length === 0) fail(`No *.json transcripts under ${SOURCE}`);

if (check) {
  if (!existsSync(TARGET)) fail("Golden drift: test/fixtures/golden is missing. Run node scripts/sync-golden.mjs");
  const copied = readdirSync(TARGET)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const drift = [];
  for (const name of names) {
    if (!copied.includes(name)) {
      drift.push(`missing: ${name}`);
      continue;
    }
    const from = normalize(readFileSync(path.join(SOURCE, name), "utf8"));
    const to = normalize(readFileSync(path.join(TARGET, name), "utf8"));
    if (from !== to) drift.push(`differs: ${name}`);
  }
  for (const name of copied) {
    if (!names.includes(name)) drift.push(`stale: ${name}`);
  }
  if (drift.length > 0) {
    fail(
      `Golden drift against ${ENGINE_DIR}/${RELATIVE_SOURCE}\n  ${drift.join("\n  ")}\n` +
        "Run node scripts/sync-golden.mjs and commit the result.",
    );
  }
  process.stdout.write(`test/fixtures/golden matches ${RELATIVE_SOURCE} (${names.length} file(s))\n`);
  process.exit(0);
}

mkdirSync(TARGET, { recursive: true });
for (const stale of readdirSync(TARGET).filter((name) => name.endsWith(".json"))) {
  if (!names.includes(stale)) rmSync(path.join(TARGET, stale));
}
for (const name of names) {
  writeFileSync(path.join(TARGET, name), normalize(readFileSync(path.join(SOURCE, name), "utf8")));
}
process.stdout.write(`Copied ${names.length} transcript(s) into test/fixtures/golden from ${ENGINE_DIR}\n`);
