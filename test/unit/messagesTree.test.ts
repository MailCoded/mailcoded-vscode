import assert from "node:assert/strict";

import type * as vscode from "vscode";

import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import type { EnvelopeDto } from "../../src/protocol/index.js";
import { MessagesTreeProvider } from "../../src/views/messagesTree.js";
import type { MessageTreeNode } from "../../src/views/messagesTree.js";
import { configuration, recorder } from "../mock-daemon/fakeVscode.js";
import { startSupervisor, teardown } from "./harness.test.js";

const ACCOUNT = 2;
const INBOX = 201;
const EMPTY_FOLDER = 204;
const PAGE_SIZE = 50;

const ESC = String.fromCodePoint(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** Mirrors MESSAGE_COUNTS and HOSTILE_SUBJECT in test/mock-daemon/scenarios.mjs. */
const INBOX_TOTAL = 257;
const HOSTILE_SUBJECT = `${ESC}[31mPayment${BIDI_OVERRIDE}fdp.exe${ZERO_WIDTH_SPACE}`;

/** A supervisor whose output channel is disposed: reporting a failure must not become one. */
function deafened(supervisor: object): MailcodedDaemonSupervisor {
  const dead = {
    appendLine: (): never => {
      throw new Error("this output channel is disposed");
    },
  };
  return new Proxy(supervisor, {
    get: (target, key) => {
      if (key === "output") return dead;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function"
        ? (value as (this: unknown, ...args: readonly unknown[]) => unknown).bind(target)
        : value;
    },
  }) as MailcodedDaemonSupervisor;
}

async function messagesView(scenario = "accounts"): Promise<MessagesTreeProvider> {
  const started = await startSupervisor(scenario, { waitFor: ["ready"] });
  return new MessagesTreeProvider(started.supervisor as unknown as MailcodedDaemonSupervisor);
}

function envelopes(nodes: readonly MessageTreeNode[]): readonly EnvelopeDto[] {
  return nodes.flatMap((node) =>
    node.kind === "message" ? [node.envelope] : node.kind === "thread" ? [...node.envelopes] : [],
  );
}

function kinds(nodes: readonly MessageTreeNode[]): readonly string[] {
  return nodes.map((node) => node.kind);
}

function labelOf(item: vscode.TreeItem): string {
  return typeof item.label === "string" ? item.label : (item.label?.label ?? "");
}

/** `loadMore` is idempotent once the cursor runs out, so the loop terminates on the node itself. */
async function drain(view: MessagesTreeProvider): Promise<MessageTreeNode[]> {
  let nodes = await view.getChildren();
  for (let page = 1; page < 20 && kinds(nodes).includes("loadMore"); page += 1) {
    await view.loadMore();
    nodes = await view.getChildren();
  }
  return nodes;
}

describe("the message list", () => {
  beforeEach(() => {
    recorder.reset();
    configuration.set("mailcoded.pageSize", PAGE_SIZE);
    configuration.set("mailcoded.threadGrouping", false);
  });

  afterEach(async () => {
    configuration.delete("mailcoded.pageSize");
    configuration.delete("mailcoded.threadGrouping");
    await teardown();
  });

  it("shows nothing at all until a folder is chosen", async () => {
    const view = await messagesView();
    assert.equal(view.scope, undefined);
    assert.deepEqual(await view.getChildren(), []);
    view.dispose();
  });

  it("asks for one page of the configured size and offers to fetch the next", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    const nodes = await view.getChildren();
    assert.equal(envelopes(nodes).length, PAGE_SIZE, "a folder browse is one page, never the folder");
    assert.deepEqual(kinds(nodes).slice(-1), ["loadMore"], "a cursor remains, so the row must be offered");
    assert.equal(view.messageCount, PAGE_SIZE);
    view.dispose();
  });

  it("honours a smaller page size, which is the limit it puts on the wire", async () => {
    configuration.set("mailcoded.pageSize", 25);
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    assert.equal(envelopes(await view.getChildren()).length, 25);
    view.dispose();
  });

  it("pages a folder deeper than one page all the way down, without repeating a row", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    const nodes = await drain(view);
    const loaded = envelopes(nodes);
    assert.equal(loaded.length, INBOX_TOTAL, `the folder holds ${String(INBOX_TOTAL)} messages`);
    assert.ok(INBOX_TOTAL > PAGE_SIZE, "the fixture must need more than one page");
    assert.equal(new Set(loaded.map((hit) => hit.id)).size, INBOX_TOTAL, "an id came back twice");
    assert.equal(kinds(nodes).includes("loadMore"), false, "the last page has no cursor to follow");
    assert.equal(kinds(nodes).includes("notice"), false, "date order drops nothing, so there is nothing to say");
    view.dispose();
  });

  it("keeps the order the daemon returned, newest first", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    await view.loadMore();

    const dates = envelopes(await view.getChildren()).map((hit) => hit.date);
    assert.deepEqual(dates, [...dates].sort().reverse(), "date order must survive two pages");
    view.dispose();
  });

  it("renders an empty folder as an empty list, not as a failure", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: EMPTY_FOLDER, folderName: "Sent" });

    assert.deepEqual(await view.getChildren(), []);
    assert.equal(view.messageCount, 0);
    assert.equal(recorder.everything().includes("search failed"), false, "nothing failed");
    view.dispose();
  });

  it("tells the user matches were dropped when relevance paging cannot reach them", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, query: "invoice" });

    const nodes = await view.getChildren();
    const notices = nodes.filter((node) => node.kind === "notice");
    assert.equal(notices.length, 1, "truncated with a null cursor means matches are unreachable");
    assert.equal(kinds(nodes).includes("loadMore"), false, "there is no cursor to follow");

    const notice = notices[0];
    assert.ok(notice !== undefined && notice.kind === "notice");
    assert.match(notice.detail, /narrow the query|sort by date/i);

    const item = view.getTreeItem(notice);
    const icon = item.iconPath as { id?: string } | undefined;
    assert.equal(icon?.id, "info", "dropped matches are information, not an error");
    assert.equal(item.contextValue, "notice");
    view.dispose();
  });

  it("says so when nothing matched every word, without hiding the dropped-matches notice", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, query: "invoice roof" });

    const nodes = await view.getChildren();
    const notices = nodes.filter((node) => node.kind === "notice");
    assert.equal(notices.length, 2, "a widened query that also drops matches has two things to say");

    const texts = notices.map((node) => (node.kind === "notice" ? node.text : ""));
    assert.ok(
      texts.some((text) => /every word/i.test(text)),
      `expected a relaxed notice, got ${JSON.stringify(texts)}`,
    );

    const ids = notices.map((node) => view.getTreeItem(node).id);
    assert.equal(new Set(ids).size, ids.length, "two notices sharing a TreeItem id: VS Code drops one");
    view.dispose();
  });

  it("says when meaning took part in the ranking, and offers no next page", async () => {
    const view = await messagesView("accountsSemantic");
    view.show({ accountId: ACCOUNT, query: "the leaking roof thing" });

    const nodes = await view.getChildren();
    const notices = nodes.filter((node) => node.kind === "notice");
    const notice = notices[0];

    assert.equal(notices.length, 1);
    assert.ok(notice !== undefined && notice.kind === "notice");
    assert.match(notice.text, /meaning/i);
    assert.match(notice.detail, /may not be relevant/i, "the page fills up; say so rather than imply relevance");
    assert.equal(kinds(nodes).includes("loadMore"), false, "a fused ranking is one page");
    assert.equal(view.getTreeItem(notice).id, "notice:semantic");
    view.dispose();
  });

  it("asks for words only when the search mode says so", async () => {
    configuration.set("mailcoded.searchMode", "words");
    try {
      const view = await messagesView("accountsSemantic");
      view.show({ accountId: ACCOUNT, query: "the leaking roof thing" });

      const nodes = await view.getChildren();
      assert.equal(
        nodes.some((node) => node.kind === "notice" && /meaning/i.test(node.text)),
        false,
        "searchMode 'words' must send semantic:false, which the mock answers without fusing",
      );
      view.dispose();
    } finally {
      configuration.delete("mailcoded.searchMode");
    }
  });

  it("renders empty rather than throwing when meaning is asked of a daemon without a model", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, query: "the leaking roof thing", semantic: true });

    assert.deepEqual(await view.getChildren(), [], "1008 is a refusal, not a crash");
    assert.ok(recorder.everything().includes("search failed"), "the refusal is logged");
    view.dispose();
  });

  it("keeps a truncated folder page paging rather than calling it a loss", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    const nodes = await view.getChildren();
    assert.equal(kinds(nodes).includes("notice"), false, "in date order truncated only means 'another page'");
    assert.ok(kinds(nodes).includes("loadMore"));
    view.dispose();
  });

  it("strips a control, bidi or zero-width code point out of a row before it is rendered", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    const nodes = await view.getChildren();

    const rendered = nodes.map((node) => JSON.stringify(view.getTreeItem(node))).join("\n");
    assert.ok(!rendered.includes(ESC), "an ESC survived into a row");
    assert.ok(!rendered.includes(BIDI_OVERRIDE), "a U+202E survived into a row");
    assert.ok(!rendered.includes(ZERO_WIDTH_SPACE), "a U+200B survived into a row");

    const first = nodes[0];
    assert.ok(first !== undefined && first.kind === "message");
    assert.equal(first.envelope.subject, HOSTILE_SUBJECT, "the fixture must carry the raw code points");
    assert.match(labelOf(view.getTreeItem(first)), /^\[31mPaymentfdp\.exe$/);
    view.dispose();
  });

  it("carries only the message id in the row's command", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    const nodes = await view.getChildren();

    for (const node of nodes) {
      if (node.kind !== "message") continue;
      const command = view.getTreeItem(node).command;
      assert.equal(command?.command, "mailcoded.openMessage");
      assert.deepEqual(command?.arguments, [node.envelope.id]);
    }
    view.dispose();
  });

  it("groups a conversation the daemon already sent, and expands it without another call", async () => {
    configuration.set("mailcoded.threadGrouping", true);
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    const nodes = await view.getChildren();
    const threads = nodes.filter((node) => node.kind === "thread");
    assert.ok(threads.length > 0, "the fixture puts four messages on each thread key");

    const thread = threads[0];
    assert.ok(thread !== undefined && thread.kind === "thread");
    assert.deepEqual(await view.getChildren(thread), thread.envelopes.map((envelope) => ({
      kind: "message",
      envelope,
    })));
    assert.equal(envelopes(nodes).length, PAGE_SIZE, "grouping must not lose a message");
    view.dispose();
  });

  it("patches one row in place instead of re-running the search", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    const before = envelopes(await view.getChildren());
    const target = before[0];
    assert.ok(target !== undefined);

    view.patch({ ...target, flags: [], tags: ["triaged"] });
    const after = envelopes(await view.getChildren());
    const patched = after[0];
    assert.ok(patched !== undefined);
    assert.equal(after.length, before.length, "a patch must not change the window");
    assert.deepEqual(patched.tags, ["triaged"]);
    assert.equal(view.getTreeItem({ kind: "message", envelope: patched }).contextValue, "message.read");
    view.dispose();
  });

  it("renders an empty list rather than rejecting when the daemon refuses the search", async () => {
    const view = await messagesView("accountsSearchFails");
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });

    assert.deepEqual(await view.getChildren(), [], "getChildren must resolve, never reject");
    assert.deepEqual(await view.getChildren(), [], "and must not re-fire the failing search on a repaint");
    await view.loadMore();
    assert.ok(recorder.everything().includes("1004"), "the code alone reaches the channel");
    assert.equal(recorder.everything().includes("INBOX"), false, "no params, no results");
    view.dispose();
  });

  it("resolves getChildren even when reporting the failure is itself broken", async () => {
    const started = await startSupervisor("accountsSearchFails", { waitFor: ["ready"] });
    const view = new MessagesTreeProvider(deafened(started.supervisor));
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    assert.deepEqual(await view.getChildren(), [], "a dead output channel must not reject the view");
    await view.loadMore();
    view.dispose();
  });

  it("forgets its page when the view is disposed", async () => {
    const view = await messagesView();
    view.show({ accountId: ACCOUNT, folderId: INBOX, folderName: "INBOX" });
    await view.getChildren();
    view.dispose();

    assert.equal(view.messageCount, 0);
    assert.deepEqual(await view.getChildren(), []);
  });
});
