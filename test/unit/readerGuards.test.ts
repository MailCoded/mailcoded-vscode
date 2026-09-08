import assert from "node:assert/strict";

import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import { RpcError } from "../../src/daemon/types.js";
import type { EnvelopeDto, MessageGetResult } from "../../src/protocol/index.js";
import type { MessageReader, MessageTagger } from "../../src/reader/messageDocument.js";
import { createReaderPanel } from "../../src/reader/readerPanel.js";
import type { ReaderPanel } from "../../src/reader/readerPanel.js";
import { Uri, configuration, recorder } from "../mock-daemon/fakeVscode.js";
import type { FakeWebviewPanel } from "../mock-daemon/fakeVscode.js";

const EXTENSION_ROOT = "/opt/mailcoded-vscode";
const OPENING = "Opening the message…";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function envelope(id: number): EnvelopeDto {
  return {
    id,
    accountId: 1,
    folderId: 12,
    date: "2026-09-07T22:00:00.000Z",
    from: `Sender ${String(id)} <s${String(id)}@example.com>`,
    subject: `subject ${String(id)}`,
    flags: [],
    tags: [],
    hasAttachments: true,
    size: 512,
    bodyFetched: false,
  };
}

function result(id: number, format: string): MessageGetResult {
  return {
    envelope: envelope(id),
    bodyText: `text of ${String(id)}`,
    ...(format === "html" ? { bodyHtml: `<p>html of ${String(id)}</p>` } : {}),
    attachments: [{ index: 0, filename: "note.txt", mime: "text/plain", size: 0, isInline: false }],
    bodyFetched: true,
    parseWarnings: [],
  };
}

interface Controlled {
  readonly reader: ReaderPanel;
  readonly calls: string[];
  readonly fallbacks: number[];
  hold(messageId: number, format?: string): () => void;
  fail(messageId: number, error: Error): void;
}

const opened: ReaderPanel[] = [];

function controlled(): Controlled {
  const calls: string[] = [];
  const fallbacks: number[] = [];
  const holds = new Map<string, () => void>();
  const failures = new Map<number, Error>();

  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const messageId = Number(params["messageId"]);
    if (method === "attachment.get") {
      calls.push(`attachment.get:${String(messageId)}`);
      return { filename: "note.txt", mime: "text/plain", base64: "", size: 0 };
    }
    const format = typeof params["format"] === "string" ? params["format"] : "text";
    calls.push(`message.get:${String(messageId)}:${format}`);
    const key = `${String(messageId)}:${format}`;
    const held = holds.get(key);
    if (held !== undefined) {
      await new Promise<void>((resolve) => holds.set(key, resolve));
      holds.delete(key);
    }
    const failure = failures.get(messageId);
    if (failure !== undefined) {
      throw failure;
    }
    return result(messageId, format);
  };

  const supervisor = {
    client: { request },
    output: { appendLine: (line: string) => recorder.record("Mailcoded Daemon", line) },
  } as unknown as MailcodedDaemonSupervisor;

  const tagger: MessageTagger = { setTags: (): Promise<void> => Promise.resolve() };
  const fallback: MessageReader = {
    open: (messageId: number): Promise<void> => {
      fallbacks.push(messageId);
      return Promise.resolve();
    },
    dispose: (): void => undefined,
  };

  const reader = createReaderPanel(supervisor, Uri.file(EXTENSION_ROOT) as never, tagger, fallback);
  opened.push(reader);
  return {
    reader,
    calls,
    fallbacks,
    hold(messageId: number, format = "text"): () => void {
      const key = `${String(messageId)}:${format}`;
      holds.set(key, () => undefined);
      return () => {
        const release = holds.get(key);
        holds.delete(key);
        if (release !== undefined) release();
      };
    },
    fail(messageId: number, error: Error): void {
      failures.set(messageId, error);
    },
  };
}

function panels(): readonly FakeWebviewPanel[] {
  return recorder.webviewPanels;
}

function only(): FakeWebviewPanel {
  assert.equal(panels().length, 1, `expected one panel, found ${String(panels().length)}`);
  const panel = panels()[0];
  assert.ok(panel !== undefined);
  return panel;
}

function frameKinds(panel: FakeWebviewPanel): readonly string[] {
  return panel.posted.map((frame) => String((frame as { type?: unknown }).type));
}

describe("the reader shows the message the user asked for last", () => {
  afterEach(() => {
    for (const reader of opened.splice(0)) {
      reader.dispose();
    }
    configuration.delete("mailcoded.readerDefault");
    recorder.reset();
  });

  it("does not let a slower earlier open replace the message clicked after it", async () => {
    const context = controlled();
    const release = context.hold(11);

    const first = context.reader.open(11);
    await tick();
    await context.reader.open(22);
    assert.equal(only().title, "subject 22");

    release();
    await first;

    assert.equal(only().title, "subject 22", "the click the user made last owns the screen");
    assert.deepEqual(frameKinds(only()), []);
    assert.equal(only().webview.html.includes("mc-body") ? "loaded" : "empty", "loaded");
  });

  it("still keeps the body the abandoned fetch paid for", async () => {
    const context = controlled();
    const release = context.hold(11);
    const first = context.reader.open(11);
    await tick();
    await context.reader.open(22);
    release();
    await first;

    await context.reader.open(11);

    assert.equal(only().title, "subject 11");
    assert.equal(
      context.calls.filter((call) => call === "message.get:11:text").length,
      1,
      "a body already fetched must not be fetched again",
    );
  });

  it("creates no panel until there is something to put in it", async () => {
    const context = controlled();
    const release = context.hold(11);

    const opening = context.reader.open(11);
    await tick();
    assert.deepEqual(panels(), [], "a blank editor must not sit there for the length of the fetch");
    assert.ok(recorder.progress.includes(OPENING), "the wait has to be visible somewhere");

    release();
    await opening;
    assert.equal(only().title, "subject 11");
  });

  it("leaves no panel behind when the fetch fails, and says what happened", async () => {
    const context = controlled();
    context.fail(11, new RpcError(1001, "The connection was reset.", { category: "network" }));

    await context.reader.open(11);

    assert.deepEqual(panels(), []);
    assert.equal(recorder.notifications.length, 1, recorder.notifications.join("\n"));
  });

  it("says nothing about a failure the user has already moved on from", async () => {
    const context = controlled();
    context.fail(11, new RpcError(1001, "The connection was reset.", { category: "network" }));
    const release = context.hold(11);

    const first = context.reader.open(11);
    await tick();
    await context.reader.open(22);
    release();
    await first;

    assert.deepEqual(recorder.notifications, [], "a toast about an abandoned click is noise");
    assert.equal(only().title, "subject 22");
  });
});

describe("the reader and a panel the user closed", () => {
  afterEach(() => {
    for (const reader of opened.splice(0)) {
      reader.dispose();
    }
    configuration.delete("mailcoded.readerDefault");
    recorder.reset();
  });

  it("does not re-open the reader for an html render the user closed mid-flight", async () => {
    configuration.set("mailcoded.readerDefault", "html");
    const context = controlled();
    const release = context.hold(11, "html");

    const opening = context.reader.open(11);
    await tick();
    only().dispose();

    release();
    await opening;

    assert.equal(panels().length, 1, "a late render must not put the reader back on the screen");
    assert.ok(panels()[0]?.disposed);
  });

  it("does not throw when the reader is closed while a second message loads", async () => {
    const context = controlled();
    await context.reader.open(22);
    const release = context.hold(11);

    const opening = context.reader.open(11);
    await tick();
    panels()[0]?.dispose();

    release();
    await opening;

    assert.equal(panels().length, 2, "an open the user asked for may open a panel again");
    assert.equal(panels()[1]?.title, "subject 11");
  });
});

describe("the reader tells the user what it is doing", () => {
  afterEach(() => {
    for (const reader of opened.splice(0)) {
      reader.dispose();
    }
    configuration.delete("mailcoded.readerDefault");
    recorder.reset();
  });

  it("delivers the queued status once the document is ready, after the frame", async () => {
    configuration.set("mailcoded.readerDefault", "html");
    const context = controlled();
    const release = context.hold(11, "html");

    const opening = context.reader.open(11);
    await tick();
    const panel = only();
    panel.receive({ type: "ready" });

    assert.deepEqual(frameKinds(panel).slice(0, 2), ["render", "status"]);

    release();
    await opening;
    assert.deepEqual(frameKinds(panel), ["render", "status", "render"]);
  });

  it("says so when an attachment has no bytes to save", async () => {
    const context = controlled();
    await context.reader.open(11);
    const panel = only();
    panel.receive({ type: "ready" });

    panel.receive({ type: "saveAttachment", index: 0 });
    await tick();

    assert.ok(
      recorder.notifications.some((text) => /no bytes to save/.test(text)),
      recorder.notifications.join("\n"),
    );
  });
});
