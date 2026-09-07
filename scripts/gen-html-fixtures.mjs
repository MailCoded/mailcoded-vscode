#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "html");
const PROTOCOL_VERSION = 1;
const FRAME_HEAD = "\r\n\r\n";
const REQUEST_TIMEOUT_MS = 20_000;

function engineDir() {
  const named = process.env["MAILCODED_ENGINE_DIR"];
  const candidate = named && named !== "" ? named : path.join(REPO_ROOT, "..", "mailcoded");
  const resolved = path.resolve(candidate);
  if (!existsSync(path.join(resolved, "fixtures", "eml"))) {
    throw new Error(`No engine checkout at ${resolved}. Set MAILCODED_ENGINE_DIR.`);
  }
  return resolved;
}

function executable(engine, override, project, name) {
  const named = process.env[override];
  if (named && named !== "") return named;
  for (const configuration of ["Release", "Debug"]) {
    const root = path.join(engine, "src", project, "bin", configuration);
    if (!existsSync(root)) continue;
    for (const framework of readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, framework, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Error(`No ${name} built under ${engine}. Run 'dotnet build' there, or set ${override}.`);
}

/** Content-Length framing, as in src/daemon/connection.ts. */
function client(command, store) {
  const child = spawn(command, ["--store", store, "--log-level", "off"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  let buffer = Buffer.alloc(0);
  let nextId = 0;

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf(FRAME_HEAD);
      if (separator < 0) return;
      const head = buffer.subarray(0, separator).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(head);
      if (match === null) throw new Error("A frame arrived without a Content-Length header.");
      const length = Number(match[1]);
      const start = separator + FRAME_HEAD.length;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      const message = JSON.parse(body);
      const settle = waiting.get(message.id);
      if (settle !== undefined) {
        waiting.delete(message.id);
        settle(message);
      }
    }
  });

  return {
    request(method, params) {
      const id = ++nextId;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${payload.length}${FRAME_HEAD}`);
      child.stdin.write(payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS} ms.`));
        }, REQUEST_TIMEOUT_MS);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          if (message.error !== undefined) {
            reject(new Error(`${method} failed with ${message.error.code}: ${message.error.message}`));
            return;
          }
          resolve(message.result);
        });
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** `import-eml` hands out ids in the directory's sorted order, which is how a fixture gets named
 * after its .eml; `plainSubject` verifies that per message rather than trusting it. `--one-shot`
 * is unusable here: an uninitialised caller is an agent, and agents are denied HTML (1006). */
function plainSubject(file) {
  const raw = readFileSync(file, "latin1");
  const headers = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const match = /^subject:[ \t]*(.*)$/im.exec(unfolded);
  if (match === null) return undefined;
  const value = (match[1] ?? "").trim();
  if (value === "" || value.includes("=?") || !/^[\x20-\x7e]*$/.test(value)) return undefined;
  return value.replace(/\s+/g, " ");
}

function collapse(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

async function main() {
  const engine = engineDir();
  const emlDir = path.join(engine, "fixtures", "eml");
  const cli = executable(engine, "MAILCODED_CLI", "Mailcoded.Cli", "mailcoded");
  const daemon = executable(engine, "MAILCODED_DAEMON", "Mailcoded.Daemon", "mailcoded-daemon");
  const names = readdirSync(emlDir)
    .filter((entry) => entry.endsWith(".eml"))
    .sort();

  const dataDir = mkdtempSync(path.join(tmpdir(), "mailcoded-html-fixtures-"));
  let written = 0;

  try {
    const report = JSON.parse(
      execFileSync(cli, ["import-eml", emlDir, "--data-dir", dataDir, "--json"], { encoding: "utf8" }),
    );
    if (report.ok !== true || report.imported !== names.length) {
      throw new Error(`Imported ${String(report.imported)} of ${String(names.length)} .eml file(s).`);
    }

    const connection = client(daemon, path.join(dataDir, "store.db"));

    try {
      const initialized = await connection.request("initialize", {
        clientName: "gen-html-fixtures",
        clientVersion: "0.0.0",
        protocolVersion: PROTOCOL_VERSION,
        interface: "rpc",
      });
      if (initialized.capabilities?.htmlBodies !== true) {
        throw new Error("This daemon does not offer HTML bodies to an 'rpc' caller.");
      }

      mkdirSync(OUT_DIR, { recursive: true });
      for (const stale of readdirSync(OUT_DIR).filter((entry) => entry.endsWith(".html"))) {
        rmSync(path.join(OUT_DIR, stale));
      }

      for (const [offset, name] of names.entries()) {
        const messageId = offset + 1;
        const message = await connection.request("message.get", {
          messageId,
          format: "html",
          fetchIfMissing: false,
        });

        const expected = plainSubject(path.join(emlDir, name));
        if (expected !== undefined && collapse(message.envelope?.subject) !== expected) {
          throw new Error(`Message ${String(messageId)} is not ${name}: the store reordered the import.`);
        }

        const html = typeof message.bodyHtml === "string" ? message.bodyHtml : "";
        if (html.trim() === "") continue;

        const target = path.join(OUT_DIR, `${path.basename(name, ".eml")}.html`);
        writeFileSync(target, html.endsWith("\n") ? html : `${html}\n`, "utf8");
        written += 1;
        process.stdout.write(`${path.relative(REPO_ROOT, target)}  ${String(html.length)} bytes\n`);
      }
    } finally {
      connection.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  const textOnly = names.length - written;
  process.stdout.write(
    `Wrote ${String(written)} HTML fixture(s) from ${String(names.length)} .eml file(s); ` +
      `${String(textOnly)} carry no HTML part.\n`,
  );
  if (written === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
