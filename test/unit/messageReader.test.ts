import assert from "node:assert/strict";

import { getMessage, searchMessages } from "../../src/daemon/client.js";
import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import type { MailcodedClient } from "../../src/daemon/types.js";
import type { EnvelopeDto } from "../../src/protocol/index.js";
import { MESSAGE_SCHEME, createMessageReader, messageUri } from "../../src/reader/messageDocument.js";
import type { MessageTagger } from "../../src/reader/messageDocument.js";
import { Uri, configuration, recorder, workspace } from "../mock-daemon/fakeVscode.js";
import { rejects, startSupervisor, teardown } from "./harness.test.js";

const GOLDEN_MESSAGE_ID = 1;

interface Written {
  readonly id: number;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

function recordingTagger(): { tagger: MessageTagger; writes: Written[] } {
  const writes: Written[] = [];
  return {
    writes,
    tagger: {
      setTags: (envelope: EnvelopeDto, add: readonly string[], remove: readonly string[]): Promise<void> => {
        writes.push({ id: envelope.id, add, remove });
        return Promise.resolve();
      },
    },
  };
}

async function client(scenario = "accounts"): Promise<MailcodedClient> {
  const started = await startSupervisor(scenario, { waitFor: ["ready"] });
  return started.supervisor.client;
}

async function supervisor(scenario = "accounts"): Promise<MailcodedDaemonSupervisor> {
  const started = await startSupervisor(scenario, { waitFor: ["ready"] });
  return started.supervisor as unknown as MailcodedDaemonSupervisor;
}

describe("search is never unbounded", () => {
  afterEach(teardown);

  it("puts a limit on the wire even when the caller passed none", async () => {
    const result = await searchMessages(await client(), { query: "invoice" });
    assert.ok(result.hits.length > 0, "the mock rejects a search that carries no limit");
  });

  it("clamps a limit above the daemon's ceiling instead of being refused", async () => {
    const wide = await client();
    assert.equal(wide.capabilities.maxSearchLimit, 200);
    const result = await searchMessages(wide, { query: "", folderId: 201, order: "date", limit: 5000 });
    assert.equal(result.hits.length, 200, "the clamp is silent, so 5000 must arrive as 200");
  });

  it("refuses a limit below one rather than sending it", async () => {
    const result = await searchMessages(await client(), { query: "invoice", limit: 0 });
    assert.ok(result.hits.length > 0);
  });
});

describe("the reader asks for plaintext and nothing else", () => {
  afterEach(teardown);

  it("gets a message as text", async () => {
    const message = await getMessage(await client(), GOLDEN_MESSAGE_ID, true);
    assert.equal(message.envelope.id, GOLDEN_MESSAGE_ID);
  });

  it("would be refused if it ever asked for html or raw", async () => {
    const wide = await client();
    for (const format of ["html", "raw"]) {
      const error = await rejects(() =>
        wide.request("message.get", { messageId: GOLDEN_MESSAGE_ID, format, fetchIfMissing: true }),
      );
      assert.match(String(error), /plaintext only/, `the mock must reject '${format}'`);
    }
  });
});

describe("the message reader", () => {
  beforeEach(() => {
    recorder.reset();
  });

  afterEach(async () => {
    configuration.delete("mailcoded.markReadOnOpen");
    await teardown();
  });

  it("names the document by id and renders it as a plaintext header block", async () => {
    const { tagger } = recordingTagger();
    const reader = createMessageReader(await supervisor(), tagger);

    await reader.open(GOLDEN_MESSAGE_ID);
    const shown = recorder.shownDocuments;
    assert.equal(shown.length, 1);

    const document = shown[0];
    assert.ok(document !== undefined);
    assert.equal(document.uri.scheme, MESSAGE_SCHEME);
    assert.equal(document.languageId, "plaintext", "the reader is a plain document, never a webview");
    assert.match(document.getText(), /^Subject: /);
    assert.match(document.getText(), /\nFrom: {4}\S/, "labels are padded to nine columns");
    assert.ok(document.getText().endsWith("\n"));
    reader.dispose();
  });

  it("marks an unread message read on open, and only through the tagger", async () => {
    const { tagger, writes } = recordingTagger();
    const reader = createMessageReader(await supervisor(), tagger);

    await reader.open(GOLDEN_MESSAGE_ID);
    assert.deepEqual(writes, [{ id: GOLDEN_MESSAGE_ID, add: [], remove: ["unread"] }]);
    reader.dispose();
  });

  it("leaves the message unread when the setting is off", async () => {
    configuration.set("mailcoded.markReadOnOpen", false);
    const { tagger, writes } = recordingTagger();
    const reader = createMessageReader(await supervisor(), tagger);

    await reader.open(GOLDEN_MESSAGE_ID);
    assert.deepEqual(writes, []);
    reader.dispose();
  });

  it("still opens the message when the tag write fails, and logs the code only", async () => {
    const reader = createMessageReader(await supervisor(), {
      setTags: () => Promise.reject(new Error("nope")),
    });

    await reader.open(GOLDEN_MESSAGE_ID);
    assert.equal(recorder.shownDocuments.length, 1, "a failed tag write must not close the reader");
    assert.match(recorder.everything(), /tags\.set failed/);
    reader.dispose();
  });

  it("reports a failure to the user instead of throwing, and opens nothing", async () => {
    const { tagger } = recordingTagger();
    const reader = createMessageReader(await supervisor(), tagger);

    await reader.open(9_999_999);
    assert.equal(recorder.shownDocuments.length, 0);
    assert.ok(recorder.notifications.length > 0, "the user is told, not the console");
    reader.dispose();
  });

  it("serves a URI that names no message without reaching for the daemon", async () => {
    const { tagger } = recordingTagger();
    const reader = createMessageReader(await supervisor(), tagger);

    const document = await workspace.openTextDocument(Uri.parse(`${MESSAGE_SCHEME}:notes/x.txt`, true));
    assert.match(document.getText(), /names no message/);
    reader.dispose();
  });

  it("keeps the subject out of everything but the display name of the URI", () => {
    const uri = messageUri(42, "../../etc/passwd?x=1");
    assert.equal(uri.scheme, MESSAGE_SCHEME);
    assert.match(uri.toString(), /^mailcoded-message:42\//);
    assert.ok(!uri.toString().includes("?"), uri.toString());
  });
});
