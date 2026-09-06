#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";

import { scenario } from "./scenarios.mjs";

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const HEADER_TERMINATOR = "\r\n\r\n";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

const SCENARIO_NAME = flag("scenario", process.env.MOCK_DAEMON_SCENARIO ?? "happy");
const JOURNAL = flag("journal", process.env.MOCK_DAEMON_JOURNAL ?? "");
const active = scenario(SCENARIO_NAME);

function log(line) {
  process.stderr.write(`mock-daemon[${process.pid}] ${line}\n`);
}

/** Method names, ids and timings only: the journal is an assertion surface, not a transcript. */
function journal(entry) {
  if (JOURNAL === "") return;
  try {
    appendFileSync(JOURNAL, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  } catch {
    log("journal write failed");
  }
}

let pendingWrites = 0;

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  pendingWrites += 1;
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]), () => {
    pendingWrites -= 1;
  });
}

function exitNow(code) {
  const start = Date.now();
  const waitForDrain = () => {
    if (pendingWrites === 0 || Date.now() - start > 200) {
      journal({ event: "exit", code });
      process.exit(code);
    }
    setTimeout(waitForDrain, 5);
  };
  waitForDrain();
}

let stopped = false;
let buffer = Buffer.alloc(0);

const ctx = {
  initializeOptions: active.initializeOptions,
  reply(id, result) {
    writeFrame({ jsonrpc: "2.0", id, result });
  },
  error(id, code, message, data) {
    writeFrame({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
  },
  errorNoId(code, message, data) {
    writeFrame({ jsonrpc: "2.0", id: null, error: data === undefined ? { code, message } : { code, message, data } });
  },
  notify(method, params) {
    writeFrame({ jsonrpc: "2.0", method, params });
  },
  after(ms, run) {
    setTimeout(run, ms);
  },
  exitAfter(ms, code) {
    setTimeout(() => exitNow(code), ms);
  },
  stopReading() {
    stopped = true;
    log("framing fault: no longer reading stdin");
  },
  log,
};

function fatalFraming(reason) {
  log(`framing rejected: ${reason}`);
  ctx.errorNoId(-32700, "The request body was not valid JSON.", { category: "protocol" });
  ctx.stopReading();
}

function contentLength(header) {
  let length;
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const raw = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(raw)) return -1;
    length = Number(raw);
  }
  if (length === undefined || length <= 0 || length > MAX_BODY_BYTES) return -1;
  return length;
}

function dispatch(body) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    fatalFraming("body was not JSON");
    return;
  }
  if (Array.isArray(request) || typeof request !== "object" || request === null) {
    fatalFraming("body was not a request object");
    return;
  }
  const entry = { event: "request", method: request.method, id: request.id ?? null };
  if (request.method === "initialize" && request.params) {
    const { clientName, clientVersion, protocolVersion, interface: surface } = request.params;
    entry.handshake = { clientName, clientVersion, protocolVersion, interface: surface };
  }
  journal(entry);
  log(`<- ${String(request.method)}`);
  active.handle(ctx, request);
}

function consume(chunk) {
  if (stopped) return;
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (stopped) return;
    const terminator = buffer.indexOf(HEADER_TERMINATOR);
    if (terminator < 0) {
      if (buffer.length > MAX_HEADER_BYTES) fatalFraming("header block exceeded 8 KiB");
      return;
    }
    const length = contentLength(buffer.subarray(0, terminator).toString("ascii"));
    if (length < 0) {
      fatalFraming("missing or invalid Content-Length");
      return;
    }
    const start = terminator + HEADER_TERMINATOR.length;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    dispatch(body);
  }
}

journal({ event: "spawn", scenario: SCENARIO_NAME });
log(`scenario=${SCENARIO_NAME}`);

process.stdin.on("data", consume);
process.stdin.on("end", () => {
  log("stdin closed");
  exitNow(0);
});
process.stdin.resume();

active.onStart?.(ctx);
