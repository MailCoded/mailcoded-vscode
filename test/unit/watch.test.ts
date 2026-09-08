import assert from "node:assert/strict";

import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import type { DaemonNotification } from "../../src/daemon/types.js";
import { createMailWatcher } from "../../src/daemon/watch.js";
import type { MailWatcher } from "../../src/daemon/watch.js";
import { recorder } from "../mock-daemon/fakeVscode.js";
import { startSupervisor, teardown, waitFor } from "./harness.test.js";
import type { StartedSupervisor } from "./harness.test.js";

const watchers: MailWatcher[] = [];

function watch(started: StartedSupervisor): MailWatcher {
  const watcher = createMailWatcher(started.supervisor as unknown as MailcodedDaemonSupervisor);
  watchers.push(watcher);
  return watcher;
}

function subscribes(started: StartedSupervisor): number {
  return started.daemon.methods().filter((method) => method === "watch.subscribe").length;
}

describe("the mail watcher", () => {
  afterEach(async () => {
    for (const watcher of watchers.splice(0)) {
      watcher.dispose();
    }
    recorder.reset();
    await teardown();
  });

  /** The bug this exists to prevent: every notification handler in the extension was unreachable
   * because nothing ever subscribed, and the notification tests subscribed for themselves. */
  it("subscribes for every account the daemon lists, with nothing in the test asking it to", async () => {
    const started = await startSupervisor("accounts", { waitFor: ["ready"] });
    const watcher = watch(started);

    await watcher.settled();

    // The mock answers -32602 unless accountId is a positive integer and folderIds is an array,
    // so two accepted subscriptions is also an assertion about the params that were sent.
    assert.deepEqual([...watcher.watching].sort((a, b) => a - b), [1, 2]);
    assert.equal(subscribes(started), 2);
  });

  it("is why notifications arrive at all: the stream starts without a test subscribing", async () => {
    const started = await startSupervisor("notify", { waitFor: ["ready"] });
    const received: DaemonNotification[] = [];
    started.supervisor.onNotification((notification) => received.push(notification));

    watch(started);

    await waitFor(
      () => received.some((notification) => notification.method === "notify.mail.added"),
      "a mail.added notification the extension asked for itself",
    );
  });

  it("does not subscribe when another daemon owns the store, and says why", async () => {
    const started = await startSupervisor("accountsSecondary", { waitFor: ["secondary"] });
    const watcher = watch(started);

    await watcher.settled();

    assert.deepEqual(watcher.watching, []);
    assert.equal(subscribes(started), 0, "a subscription no notification can follow is not worth a round trip");
    assert.match(recorder.everything(), /another daemon owns the store/);
  });

  it("subscribes again after a restart, because the subscriptions died with the process", async () => {
    const started = await startSupervisor("accounts", { waitFor: ["ready"] });
    const watcher = watch(started);
    await watcher.settled();
    assert.equal(subscribes(started), 2);

    await started.supervisor.restart();
    await waitFor(() => started.supervisor.status.state === "ready", "the replacement daemon to be ready");

    await waitFor(() => subscribes(started) >= 4, "a second round of subscriptions");
    await watcher.settled();
    assert.deepEqual([...watcher.watching].sort((a, b) => a - b), [1, 2]);
  });

  it("treats a refusal as final and never asks again", async () => {
    const started = await startSupervisor("accountsWatchRefused", { waitFor: ["ready"] });
    const watcher = watch(started);

    await watcher.settled();
    assert.deepEqual(watcher.watching, []);
    assert.equal(subscribes(started), 2, "one attempt per account");

    const after = subscribes(started);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(subscribes(started), after, "a retry loop here would ask a dead account forever");
    assert.match(recorder.everything(), /was refused: code 1008/);
  });

  it("forgets what it was watching once the daemon is gone", async () => {
    const started = await startSupervisor("accounts", { waitFor: ["ready"] });
    const watcher = watch(started);
    await watcher.settled();
    assert.equal(watcher.watching.length, 2);

    (started.supervisor as unknown as MailcodedDaemonSupervisor).dispose();
    await waitFor(() => started.supervisor.status.state === "stopped", "the supervisor to report it stopped");

    assert.deepEqual(watcher.watching, [], "a subscription cannot outlive the process that holds it");
  });

  it("logs a background sync error, which is otherwise invisible", async () => {
    const started = await startSupervisor("notify", { waitFor: ["ready"] });
    watch(started);

    await waitFor(() => /sync error on account 1 folder 1: code 1001/.test(recorder.everything()), "the sync error");
    assert.match(recorder.everything(), /network/);
  });
});
