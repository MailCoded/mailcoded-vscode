import assert from "node:assert/strict";
import path from "node:path";

import { DaemonDisconnectedError, RpcError } from "../../src/daemon/types.js";
import { delay, isRunning, rejects, startSupervisor, teardown, waitFor } from "./harness.test.js";

describe("resilience", () => {
  afterEach(teardown);

  it("correlates out-of-order responses by id", async () => {
    const started = await startSupervisor("slow", { waitFor: ["ready"] });
    const client = started.client();

    const settled: string[] = [];
    const slow = client.stats().then((result) => {
      settled.push("stats");
      return result;
    });
    await delay(50);
    const quick = client.health().then((result) => {
      settled.push("health");
      return result;
    });

    const [stats, health] = await Promise.all([slow, quick]);

    assert.deepEqual(settled, ["health", "stats"], "the later request must answer first");
    assert.equal(stats.protocolVersion, 1);
    assert.equal(health.status, "ok");
    assert.equal(health.accounts[0]?.email, "golden@example.test");
  });

  it("treats -32700 as fatal for the stream and respawns", async function () {
    this.timeout(30_000);
    const started = await startSupervisor("fatal", { waitFor: ["ready"] });
    const firstPid = started.daemon.pids()[0];
    assert.ok(firstPid !== undefined);

    const error = await rejects(() => started.client().stats());
    assert.ok(
      error instanceof DaemonDisconnectedError || (error instanceof RpcError && error.code === -32700),
      "a parse error must surface as a disconnect, never as a silent hang",
    );

    await waitFor(() => started.daemon.pids().length >= 2, "the supervisor to respawn the daemon", 20_000);
    await waitFor(
      () => started.daemon.methods().filter((method) => method === "initialize").length >= 2,
      "a second handshake on the new pipe",
      20_000,
    );
    assert.notEqual(started.daemon.pids()[1], firstPid);
  });

  it("backs off after an unexpected exit and gives up in 'failed'", async function () {
    this.timeout(120_000);
    const started = await startSupervisor("crashOnStart");

    await waitFor(() => started.supervisor.status.state === "failed", "the supervisor to give up", 110_000);

    const spawns = started.daemon.entries().filter((entry) => entry.event === "spawn");
    assert.ok(spawns.length >= 2, `expected repeated attempts, saw ${spawns.length}`);
    assert.ok(spawns.length <= 6, `expected a bounded number of attempts, saw ${spawns.length}`);

    const gaps: number[] = [];
    for (let index = 1; index < spawns.length; index += 1) {
      const previous = spawns[index - 1];
      const current = spawns[index];
      if (previous === undefined || current === undefined) continue;
      gaps.push(current.at - previous.at);
    }
    for (let index = 1; index < gaps.length; index += 1) {
      const previous = gaps[index - 1] ?? 0;
      const current = gaps[index] ?? 0;
      assert.ok(current + 150 >= previous, `restart delays must not shrink: ${gaps.join(", ")}`);
    }

    assert.equal(started.supervisor.status.state, "failed");
    assert.ok(started.statuses.some((status) => status.state === "failed"), "the transition must be published");
    assert.ok((started.supervisor.status.detail ?? "").length > 0, "'failed' needs a detail a human can act on");
  });

  it("reports a missing executable as daemonMissing rather than spinning", async () => {
    const started = await startSupervisor("happy", {
      daemonFile: path.join(path.sep === "\\" ? "C:\\" : "/", "nonexistent", "mailcoded-daemon-absent"),
      waitFor: ["daemonMissing", "failed"],
      timeoutMs: 20_000,
    });
    assert.ok(["daemonMissing", "failed"].includes(started.supervisor.status.state));
    assert.ok((started.supervisor.status.detail ?? "").length > 0);
  });

  it("closes the child and clears the client when it exits mid-session", async function () {
    this.timeout(30_000);
    const started = await startSupervisor("crash", { waitFor: ["ready"] });
    const firstPid = started.daemon.pids()[0];
    assert.ok(firstPid !== undefined);

    await rejects(() => started.client().stats());
    await waitFor(() => !isRunning(firstPid), "the crashed child to be reaped", 20_000);
    await waitFor(() => started.daemon.pids().length >= 2, "a replacement daemon", 20_000);
  });
});
