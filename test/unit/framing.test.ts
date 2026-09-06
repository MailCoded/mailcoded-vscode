import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { FolderDto, RpcMethodMap } from "../../src/protocol/index.js";
import type { MailcodedClient } from "../../src/daemon/types.js";

const MOCK_SCRIPT = fileURLToPath(new URL("../mock-daemon/mockDaemon.mjs", import.meta.url));

function frame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

function decodeFrames(raw: Buffer): unknown[] {
  const messages: unknown[] = [];
  let rest = raw;
  for (;;) {
    const terminator = rest.indexOf("\r\n\r\n");
    if (terminator < 0) return messages;
    const header = rest.subarray(0, terminator).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    assert.ok(match, `no Content-Length in ${JSON.stringify(header)}`);
    const length = Number(match[1]);
    const start = terminator + 4;
    if (rest.length < start + length) return messages;
    messages.push(JSON.parse(rest.subarray(start, start + length).toString("utf8")));
    rest = rest.subarray(start + length);
  }
}

describe("framing", () => {
  it("reads two frames in one write and one frame split across writes", async () => {
    const child = spawn(process.execPath, [MOCK_SCRIPT, "--scenario", "happy"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const both = Buffer.concat([
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientName: "t", clientVersion: "0" } }),
      frame({ jsonrpc: "2.0", id: 2, method: "account.list", params: {} }),
    ]);
    child.stdin.write(both);

    const split = frame({ jsonrpc: "2.0", id: 3, method: "health", params: {} });
    child.stdin.write(split.subarray(0, 12));
    await new Promise((resolve) => setTimeout(resolve, 60));
    child.stdin.write(split.subarray(12));

    const exit = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 400));
    child.stdin.end();
    await exit;

    const messages = decodeFrames(Buffer.concat(chunks)) as { id?: number }[];
    assert.deepEqual(
      messages.map((message) => message.id),
      [1, 2, 3],
      "every frame must be answered, however the bytes were chopped",
    );
  });

  it("answers -32700 with a null id and stops reading on a bad Content-Length", async () => {
    const child = spawn(process.execPath, [MOCK_SCRIPT, "--scenario", "happy"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.stdin.write(Buffer.from("Content-Length: not-a-number\r\n\r\n{}", "ascii"));
    child.stdin.write(frame({ jsonrpc: "2.0", id: 9, method: "health", params: {} }));

    const exit = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    await exit;

    const messages = decodeFrames(Buffer.concat(chunks)) as { id: unknown; error?: { code: number } }[];
    assert.equal(messages.length, 1, "a desynchronized stream is answered once and then abandoned");
    assert.equal(messages[0]?.id, null);
    assert.equal(messages[0]?.error?.code, -32700);
  });
});

declare const typedClient: MailcodedClient;

/** Compile-time half of the contract: the method literal has to drive both params and result. */
export async function typedSurfaceProbe(): Promise<void> {
  const folders = await typedClient.request("folder.list", { accountId: 1 });
  const list: readonly FolderDto[] = folders.folders;
  const first: FolderDto | undefined = list[0];
  void first;

  // @ts-expect-error folder.list requires an accountId
  await typedClient.request("folder.list", {});

  // @ts-expect-error there is no delete method, on this client or on the wire
  await typedClient.request("message.delete", {});

  const search: RpcMethodMap["search"]["params"] = { query: "invoice", limit: 50 };
  await typedClient.request("search", search);
}

describe("typed request surface", () => {
  it("compiles only with the generated method map", () => {
    assert.equal(typeof typedSurfaceProbe, "function");
  });
});
