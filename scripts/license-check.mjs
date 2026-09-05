#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED_IDS = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"];
const ALLOWED = new Set(ALLOWED_IDS.map((id) => id.toLowerCase()));

function tokenize(expression) {
  return expression
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
}

function parseExpression(tokens) {
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function primary() {
    const token = next();
    if (token === undefined) throw new Error("unexpected end of licence expression");
    if (token === "(") {
      const inner = or();
      if (next() !== ")") throw new Error("unbalanced parenthesis");
      return inner;
    }
    if (token === ")") throw new Error("unbalanced parenthesis");
    const allowed = ALLOWED.has(token.replace(/\+$/, "").toLowerCase());
    if (peek()?.toUpperCase() === "WITH") {
      next();
      const exception = next();
      if (exception === undefined) throw new Error("dangling WITH");
    }
    return allowed;
  }

  // Operands come first in both operators: short-circuiting would leave tokens unconsumed.
  function and() {
    let allowed = primary();
    while (peek()?.toUpperCase() === "AND") {
      next();
      allowed = primary() && allowed;
    }
    return allowed;
  }

  function or() {
    let allowed = and();
    while (peek()?.toUpperCase() === "OR") {
      next();
      allowed = and() || allowed;
    }
    return allowed;
  }

  const result = or();
  if (index !== tokens.length) throw new Error(`trailing tokens: ${tokens.slice(index).join(" ")}`);
  return result;
}

function isAllowed(expression) {
  if (typeof expression !== "string" || expression.trim() === "") return false;
  try {
    return parseExpression(tokenize(expression));
  } catch {
    return false;
  }
}

function normalizeField(license, licenses) {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && typeof license.type === "string") return license.type;
  if (Array.isArray(licenses)) {
    const parts = licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((entry) => typeof entry === "string");
    if (parts.length > 0) return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  }
  return undefined;
}

function licenseFromDisk(packagePath) {
  if (typeof packagePath !== "string") return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(packagePath, "package.json"), "utf8"));
    return normalizeField(manifest.license, manifest.licenses);
  } catch {
    return undefined;
  }
}

function readTree() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["ls", "--prod", "--json", "--all", "--long"];
  const options = { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  try {
    return JSON.parse(execFileSync(npm, args, options));
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (stdout.trim().startsWith("{")) return JSON.parse(stdout);
    throw error;
  }
}

function collect(node, into, seen) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    const key = `${name}@${dep.version ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push({
      name,
      version: dep.version,
      absent: dep.missing === true || (dep.version === undefined && dep.path === undefined),
      declared: normalizeField(dep.license, dep.licenses),
      path: dep.path,
    });
    collect(dep, into, seen);
  }
}

const tree = readTree();
const packages = [];
collect(tree, packages, new Set());
packages.sort((a, b) => a.name.localeCompare(b.name));

const direct = Object.keys(tree.dependencies ?? {}).sort();
process.stdout.write(`Direct production dependencies: ${direct.join(", ") || "(none)"}\n\n`);

const failures = [];
const warnings = [];

for (const pkg of packages) {
  const id = `${pkg.name}@${pkg.version ?? "?"}`;
  if (pkg.absent) {
    warnings.push(`${id}: not installed, so nothing to bundle`);
    continue;
  }
  const license = pkg.declared ?? licenseFromDisk(pkg.path);
  if (license === undefined) {
    failures.push(`${id}: no licence declared`);
    process.stdout.write(`  FAIL  ${id.padEnd(40)} <none>\n`);
    continue;
  }
  const ok = isAllowed(license);
  if (!ok) failures.push(`${id}: ${license}`);
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${id.padEnd(40)} ${license}\n`);
}

process.stdout.write(
  `\nChecked ${packages.length - warnings.length} of ${packages.length} production package(s) ` +
    `against ${ALLOWED_IDS.join(", ")}\n`,
);
for (const warning of warnings) process.stdout.write(`  warn: ${warning}\n`);

if (failures.length > 0) {
  process.stderr.write(`\nDisallowed licence(s):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
