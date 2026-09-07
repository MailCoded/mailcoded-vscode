import assert from "node:assert/strict";

import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import { createMessageReader } from "../../src/reader/messageDocument.js";
import type { MessageTagger } from "../../src/reader/messageDocument.js";
import { READER_VIEW_TYPE, createReaderPanel } from "../../src/reader/readerPanel.js";
import type { ReaderPanel } from "../../src/reader/readerPanel.js";
import { REAL_WEBVIEW_CSP_SOURCE, REAL_WEBVIEW_RESOURCE_AUTHORITY, Uri, recorder } from "../mock-daemon/fakeVscode.js";
import type { FakeWebviewPanel } from "../mock-daemon/fakeVscode.js";
import { startSupervisor, teardown } from "./harness.test.js";

const GOLDEN_MESSAGE_ID = 1;
const EXTENSION_ROOT = "/opt/mailcoded-vscode";

interface Frame {
  readonly type: string;
  readonly messageId?: number;
  readonly mode?: string;
}

const tagger: MessageTagger = {
  setTags: (): Promise<void> => Promise.resolve(),
};

async function panelUnderTest(): Promise<ReaderPanel> {
  const started = await startSupervisor("accounts", { waitFor: ["ready"] });
  const supervisor = started.supervisor as unknown as MailcodedDaemonSupervisor;
  return createReaderPanel(supervisor, Uri.file(EXTENSION_ROOT) as never, tagger, createMessageReader(supervisor, tagger));
}

function onlyPanel(): FakeWebviewPanel {
  assert.equal(recorder.webviewPanels.length, 1, "expected exactly one webview panel");
  const panel = recorder.webviewPanels[0];
  assert.ok(panel !== undefined);
  return panel;
}

function frames(panel: FakeWebviewPanel): readonly Frame[] {
  return panel.posted as Frame[];
}

describe("the reader panel in a real host", () => {
  afterEach(async () => {
    recorder.reset();
    await teardown();
  });

  it("opens a message into a webview whose policy carries the cspSource VS Code really passes", async () => {
    const reader = await panelUnderTest();
    await reader.open(GOLDEN_MESSAGE_ID);

    const panel = onlyPanel();
    assert.equal(panel.viewType, READER_VIEW_TYPE);
    assert.ok(
      panel.webview.html.includes(`style-src ${REAL_WEBVIEW_CSP_SOURCE} 'unsafe-inline';`),
      panel.webview.html,
    );
    assert.ok(
      panel.webview.html.includes(`src="https://${REAL_WEBVIEW_RESOURCE_AUTHORITY}${EXTENSION_ROOT}/dist/webview/main.js"`),
      panel.webview.html,
    );
    assert.deepEqual(recorder.notifications, []);
    assert.equal(recorder.shownDocuments.length, 0, "the plaintext fallback must not have opened");
  });

  it("holds the frame until the webview says ready, then delivers it", async () => {
    const reader = await panelUnderTest();
    await reader.open(GOLDEN_MESSAGE_ID);
    const panel = onlyPanel();
    assert.deepEqual(frames(panel), []);

    panel.receive({ type: "ready" });
    assert.equal(frames(panel).length, 1);
    assert.equal(frames(panel)[0]?.type, "render");
    assert.equal(frames(panel)[0]?.messageId, GOLDEN_MESSAGE_ID);
    assert.equal(frames(panel)[0]?.mode, "text");
  });

  it("re-delivers the current message when a re-created webview says ready again", async () => {
    const reader = await panelUnderTest();
    await reader.open(GOLDEN_MESSAGE_ID);
    const panel = onlyPanel();
    panel.receive({ type: "ready" });
    panel.receive({ type: "ready" });

    assert.equal(frames(panel).length, 2);
    assert.deepEqual(frames(panel)[1], frames(panel)[0]);
  });

  it("falls back to the plaintext reader, and says so, when the shell cannot be built for this host", async () => {
    recorder.setWebviewCspSource("'self' https://*.vscode-cdn.net; script-src *");
    const reader = await panelUnderTest();
    await reader.open(GOLDEN_MESSAGE_ID);

    const panel = onlyPanel();
    assert.equal(panel.webview.html, "", "no shell may be written under a policy that would not build");
    assert.ok(panel.disposed, "the empty panel must not be left on the screen");
    assert.equal(recorder.shownDocuments.length, 1, "the plaintext document must open instead");
    assert.ok(recorder.notifications.some((text) => /plain text/.test(text)), recorder.notifications.join("\n"));
    assert.ok(recorder.everything().includes("shell could not be built"), recorder.everything());
  });
});
