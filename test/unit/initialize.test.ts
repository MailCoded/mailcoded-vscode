import assert from "node:assert/strict";

import type { ConnectedDaemonStatus, DaemonStatus } from "../../src/daemon/types.js";
import { searchMessages } from "../../src/daemon/client.js";
import { CLIENT_INTERFACE, CLIENT_NAME, DaemonDisconnectedError } from "../../src/daemon/types.js";
import { RpcErrorCode } from "../../src/protocol/index.js";
import { asRpcError, delay, rejects, startSupervisor, teardown } from "./harness.test.js";

function connected(status: DaemonStatus): ConnectedDaemonStatus {
  if (status.state === "ready" || status.state === "secondary") return status;
  throw new Error(`expected a connected status, got '${status.state}' (${status.detail ?? "no detail"})`);
}

describe("initialize", () => {
  afterEach(teardown);

  it("negotiates capabilities and exposes them through supports()", async () => {
    const started = await startSupervisor("happy", { waitFor: ["ready"] });

    const status = connected(started.supervisor.status);
    assert.equal(status.state, "ready");
    assert.equal(status.daemonVersion, "0.0.0-transcript");
    assert.equal(status.capabilities.watch, true);
    assert.equal(status.capabilities.maxSearchLimit, 200);

    const client = started.client();
    assert.equal(client.daemonVersion, "0.0.0-transcript");
    assert.equal(client.supports("search"), true);
    assert.equal(client.supports("message.move"), true);
    assert.equal(client.supports("shutdown"), true);

    const accounts = await client.accountList();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.email, "golden@example.test");

    const folders = await client.folderList(1);
    assert.equal(folders.length, 3);
    assert.equal(folders[0]?.role, "inbox");

    const health = await client.health();
    assert.equal(health.status, "ok");

    const stats = await client.stats();
    assert.equal(stats.protocolVersion, 1);
  });

  it("reports whether the daemon has an embedding model", async () => {
    const without = await startSupervisor("accounts", { waitFor: ["ready"] });
    assert.equal(connected(without.supervisor.status).capabilities.semantic, false);
    await teardown();

    const withModel = await startSupervisor("accountsSemantic", { waitFor: ["ready"] });
    assert.equal(connected(withModel.supervisor.status).capabilities.semantic, true);
  });

  /** The scenario answers 1004 for every search, so a 1008 here can only have come from the client. */
  it("refuses a search by meaning locally when the daemon has no model", async () => {
    const started = await startSupervisor("accountsSearchFails", { waitFor: ["ready"] });
    const client = started.client();

    const forwarded = asRpcError(
      await rejects(() => searchMessages(client, { query: "roof", limit: 10 })),
    );
    assert.equal(forwarded.code, RpcErrorCode.StoreCorrupt, "an ordinary search reaches the daemon");

    const refused = asRpcError(
      await rejects(() => searchMessages(client, { query: "roof", limit: 10, semantic: true })),
    );
    assert.equal(refused.code, RpcErrorCode.Unsupported);
    assert.match(refused.message, /meaning/i);
  });

  it("identifies itself as the rpc interface, which is what the audit trail records", async () => {
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    const handshakes = started.daemon
      .entries()
      .flatMap((entry) => (entry.method === "initialize" ? [entry] : []))
      .map((entry) => (entry as { handshake?: Record<string, unknown> }).handshake);

    assert.equal(handshakes.length, 1);
    assert.deepEqual(handshakes[0], {
      clientName: CLIENT_NAME,
      clientVersion: "0.1.0-test",
      protocolVersion: 1,
      interface: CLIENT_INTERFACE,
    });
    assert.equal(CLIENT_INTERFACE, "rpc");
  });

  it("refuses to drive a daemon on a protocol version mismatch and does not respawn", async () => {
    const started = await startSupervisor("mismatch", { waitFor: ["protocolMismatch"] });
    assert.equal(started.supervisor.status.state, "protocolMismatch");
    assert.throws(
      () => {
        void started.supervisor.client;
      },
      DaemonDisconnectedError,
      "the client accessor must throw outside ready/secondary",
    );

    await delay(1500);

    assert.equal(started.supervisor.status.state, "protocolMismatch");
    assert.equal(started.daemon.methods().filter((method) => method === "initialize").length, 1);
    assert.equal(started.daemon.pids().length, 1);
    assert.ok(!started.statuses.some((status) => status.state === "restarting"));
  });

  it("treats capabilities.watch false as a secondary instance, not a failure", async () => {
    const started = await startSupervisor("secondary", { waitFor: ["secondary"] });

    const status = connected(started.supervisor.status);
    assert.equal(status.state, "secondary");
    assert.equal(status.capabilities.watch, false);

    const accounts = await started.client().accountList();
    assert.equal(accounts.length, 1);
    assert.ok(!started.statuses.some((entry) => entry.state === "failed"));
  });

  it("rejects an unadvertised method with 1008 without touching the wire", async () => {
    const started = await startSupervisor("minimal", { waitFor: ["ready"] });
    const client = started.client();

    assert.equal(client.supports("thread.get"), false);
    assert.equal(client.supports("search"), true);

    const error = asRpcError(
      await rejects(() => client.request("thread.get", { threadKey: "m:golden-1@example.test", limit: 50 })),
    );
    assert.equal(error.code, 1008);

    await delay(250);
    assert.ok(
      !started.daemon.methods().includes("thread.get"),
      `the daemon saw ${started.daemon.methods().join(", ")}`,
    );
  });
});
