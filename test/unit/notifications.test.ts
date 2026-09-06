import assert from "node:assert/strict";

import type { DaemonNotification, MailAddedEvent } from "../../src/daemon/types.js";
import { startSupervisor, teardown, waitFor } from "./harness.test.js";

describe("notifications", () => {
  afterEach(teardown);

  it("delivers the daemon's interleaving as one typed stream", async () => {
    const started = await startSupervisor("notify", { waitFor: ["ready"] });

    const received: DaemonNotification[] = [];
    started.supervisor.onNotification((notification) => received.push(notification));

    await started.client().request("watch.subscribe", { accountId: 1, folderIds: [1] });
    await waitFor(() => received.length >= 4, "four notifications");

    assert.deepEqual(
      received.map((notification) => notification.method),
      ["notify.mail.added", "notify.mail.added", "notify.sync.error", "notify.folder.updated"],
    );

    const added: MailAddedEvent[] = received.flatMap((notification) =>
      notification.method === "notify.mail.added" ? [notification.params] : [],
    );

    const first = added[0];
    assert.ok(first !== undefined);
    assert.equal(first.count, 25);
    assert.equal(first.messages.length, 2);
    assert.equal(first.coalesced, true, "a capped batch must tell the consumer to refresh with search");
    assert.equal(first.folderName, "INBOX");

    const second = added[1];
    assert.ok(second !== undefined);
    assert.equal(second.count, 2);
    assert.equal(second.messages.length, 2);
    assert.equal(second.coalesced, false);

    for (const notification of received) {
      if (notification.method === "notify.sync.error") {
        assert.equal(notification.params.code, 1001);
        assert.equal(notification.params.retryAfterMs, 5000);
        assert.equal(notification.params.requiresUserAction, false);
      }
      if (notification.method === "notify.folder.updated") {
        assert.equal(notification.params.folder.name, "INBOX");
        assert.equal(notification.params.accountId, 1);
      }
    }
  });

  it("keeps a subscriber attached across the connection that emitted the frames", async () => {
    const started = await startSupervisor("notify", { waitFor: ["ready"] });
    const received: DaemonNotification[] = [];
    const subscription = started.supervisor.onNotification((notification) => received.push(notification));

    await started.client().request("watch.subscribe", { accountId: 1, folderIds: [] });
    await waitFor(() => received.length >= 4, "the first batch");

    subscription.dispose();
    const seen = received.length;
    await started.client().request("watch.subscribe", { accountId: 1, folderIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, seen, "a disposed subscription must stop receiving");
  });
});
