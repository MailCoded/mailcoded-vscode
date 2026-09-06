import assert from "node:assert/strict";

import { capturedOutput, captureConsole, describeUnknown, rejects, startSupervisor, teardown } from "./harness.test.js";

const CREDENTIAL = "sentinel-credential-4f7a91c2e0";
const SEND_TOKEN = "sentinel-one-time-send-token-8b3d02";
const DRAFT_BODY = "sentinel-draft-body-2ad91f";

describe("secrecy", () => {
  afterEach(teardown);

  it("never echoes a credential, a one-time send token, or draft text", async () => {
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    const client = started.client();
    const consoleCapture = captureConsole();
    let failure: unknown;

    try {
      await client.request("secret.set", { ref: "mailcoded:golden@example.test", value: CREDENTIAL });

      const preview = await client.request("send.preview", {
        accountId: 1,
        draft: {
          to: ["a@b.test"],
          subject: `Re: ${DRAFT_BODY}`,
          bodyText: `${DRAFT_BODY}\n`,
        },
      });
      assert.equal(preview.draftId, 17, "the exchange has to have really happened");
      assert.equal(preview.preview.bodyTruncated, false);

      failure = await rejects(() => client.request("folder.list", { accountId: 999 }));
    } finally {
      consoleCapture.restore();
    }

    const haystack = capturedOutput(started.logger, consoleCapture.records);
    for (const sentinel of [CREDENTIAL, SEND_TOKEN, DRAFT_BODY]) {
      assert.ok(!haystack.includes(sentinel), `a sentinel reached a log sink:\n${haystack}`);
    }

    const surfaced = describeUnknown(failure);
    for (const sentinel of [CREDENTIAL, SEND_TOKEN, DRAFT_BODY]) {
      assert.ok(!surfaced.includes(sentinel), "an error must not be enriched with request params");
    }

    for (const marker of ["Sending request", "Received response", "Params:", "Result:"]) {
      assert.ok(!haystack.includes(marker), `vscode-jsonrpc tracing must stay off (saw '${marker}')`);
    }

    assert.ok(started.daemon.methods().includes("secret.set"), "the daemon must have seen the call");
    assert.ok(started.daemon.methods().includes("send.preview"));
    assert.ok(haystack.length > 0, "the daemon's own stderr should still be surfaced");
  });

  it("keeps the journal and the daemon's stderr free of anything we sent", async () => {
    const started = await startSupervisor("happy", { waitFor: ["ready"] });
    await started.client().request("secret.set", { ref: "mailcoded:golden@example.test", value: CREDENTIAL });

    const journal = JSON.stringify(started.daemon.entries());
    assert.ok(!journal.includes(CREDENTIAL));
    assert.ok(journal.includes("secret.set"), "method names are the only thing worth recording");
  });
});
