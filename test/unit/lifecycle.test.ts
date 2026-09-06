import assert from "node:assert/strict";

import { DAEMON_OUTPUT_CHANNEL_NAME, DaemonDisconnectedError } from "../../src/daemon/types.js";
import { recorder } from "../mock-daemon/fakeVscode.js";
import { isRunning, startSupervisor, teardown, waitFor } from "./harness.test.js";

describe("lifecycle", () => {
  afterEach(teardown);

  it("sends shutdown before closing and leaves no child behind", async function () {
    this.timeout(20_000);
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    await waitFor(() => started.daemon.pids().length >= 1, "the daemon to record its pid");
    const pids = started.daemon.pids();

    started.supervisor.dispose();

    await waitFor(() => started.daemon.methods().includes("shutdown"), "a shutdown request before the pipe closes");
    await waitFor(() => pids.every((pid) => !isRunning(pid)), "every child to exit", 15_000);

    assert.throws(() => {
      void started.supervisor.client;
    }, DaemonDisconnectedError);

    started.supervisor.dispose();
  });

  it("surfaces the daemon's stderr on the Mailcoded Daemon channel and nothing it sent", async () => {
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    await started.client().accountList();
    await waitFor(
      () => [...recorder.lines(), ...started.logger.records].some((line) => line.includes("mock-daemon")),
      "the daemon's stderr to reach an output sink",
    );

    const channelled = recorder.lines(DAEMON_OUTPUT_CHANNEL_NAME).join("\n");
    const anywhere = [...recorder.lines(), ...started.logger.records].join("\n");
    assert.ok(anywhere.includes("scenario=happy"), "the daemon's own stderr must be surfaced verbatim");
    assert.ok(!anywhere.includes("Content-Length"), "framing bytes are not diagnostics");
    assert.ok(!channelled.includes("golden@example.test"), "nothing the extension received belongs on that channel");
  });

  it("restarts on request and hands out a fresh client", async function () {
    this.timeout(30_000);
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    const before = started.client();

    await started.supervisor.restart();
    await waitFor(() => started.supervisor.status.state === "ready", "the supervisor to come back up", 20_000);
    await waitFor(
      () => started.daemon.methods().filter((method) => method === "initialize").length >= 2,
      "a second handshake",
    );

    const after = started.client();
    assert.notEqual(after, before, "callers must not keep a client across a restart");
    const accounts = await after.accountList();
    assert.equal(accounts.length, 1);
  });
});
