import assert from "node:assert/strict";

import { COMMAND_ARCHIVE, COMMAND_MOVE_TO, registerCommands } from "../../src/commands/index.js";
import type { CommandDependencies } from "../../src/commands/index.js";
import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import { folderWithRole, moveTargets } from "../../src/model/folderTree.js";
import type { EnvelopeDto, FolderDto } from "../../src/protocol/index.js";
import { commands, recorder } from "../mock-daemon/fakeVscode.js";
import { startSupervisor, teardown } from "./harness.test.js";

const OUTLOOK_ACCOUNT = 2;
const OUTLOOK_INBOX = 201;
const OUTLOOK_ARCHIVE = 202;
const IMPORT_ACCOUNT = 1;
const IMPORT_INBOX = 101;

interface Wired {
  readonly deps: CommandDependencies;
  readonly refreshed: string[];
  readonly moved: { messageId: number; toFolderId: number }[];
  readonly signIn: boolean[];
  dispose(): void;
}

function envelope(accountId: number, folderId: number): EnvelopeDto {
  return {
    id: 4213,
    accountId,
    folderId,
    date: "2026-09-09T09:00:00.000Z",
    from: "Ada <ada@example.com>",
    subject: "Quarterly report",
    flags: [],
    tags: [],
    hasAttachments: false,
    size: 1024,
    bodyFetched: true,
  };
}

function node(accountId: number, folderId: number): unknown {
  return { kind: "message", envelope: envelope(accountId, folderId) };
}

async function wire(scenario = "accounts"): Promise<Wired> {
  const started = await startSupervisor(scenario, { waitFor: ["ready"] });
  const supervisor = started.supervisor as unknown as MailcodedDaemonSupervisor;
  const refreshed: string[] = [];
  const moved: { messageId: number; toFolderId: number }[] = [];
  const signIn: boolean[] = [];

  // The mock daemon's journal records method names only, so the destination folder is observed
  // here, at the one call the commands make to move a message.
  type Request = MailcodedDaemonSupervisor["client"]["request"];
  const client = supervisor.client;
  const original: Request = client.request.bind(client);
  const spy = ((method: string, params: unknown, options?: unknown): unknown => {
    if (method === "message.move") {
      const move = params as { messageId: number; toFolderId: number };
      moved.push({ messageId: move.messageId, toFolderId: move.toFolderId });
    }
    return (original as (m: string, p: unknown, o?: unknown) => unknown)(method, params, options);
  }) as unknown as Request;
  (client as { request: Request }).request = spy;

  const deps = {
    tree: { refresh: () => refreshed.push("accounts") },
    statusBar: { setNeedsSignIn: (needed: boolean) => signIn.push(needed) },
    messages: { refresh: () => refreshed.push("messages"), scope: undefined, show: () => undefined, loadMore: () => Promise.resolve(), patch: () => undefined },
    reader: { open: () => Promise.resolve(), dispose: () => undefined },
    readerPanel: { open: () => Promise.resolve(), showHtml: () => Promise.resolve(), showText: () => Promise.resolve(), cspViolations: () => 0, dispose: () => undefined },
    tagger: { setTags: () => Promise.resolve() },
    selection: { accountId: () => undefined, message: () => undefined, revealMessages: () => undefined },
  } as unknown as CommandDependencies;

  const registration = registerCommands(supervisor, deps);
  return {
    deps,
    refreshed,
    moved,
    signIn,
    dispose: () => {
      registration.dispose();
    },
  };
}

const wired: Wired[] = [];

async function harness(scenario?: string): Promise<Wired> {
  const context = await wire(scenario);
  wired.push(context);
  return context;
}

describe("filing a message into a folder", () => {
  afterEach(async () => {
    for (const context of wired.splice(0)) {
      context.dispose();
    }
    recorder.reset();
    await teardown();
  });

  it("archives into the folder the server marked Archive", async () => {
    const context = await harness();

    await commands.executeCommand(COMMAND_ARCHIVE, node(OUTLOOK_ACCOUNT, OUTLOOK_INBOX));

    assert.deepEqual(context.moved, [{ messageId: 4213, toFolderId: OUTLOOK_ARCHIVE }]);
    assert.deepEqual([...context.refreshed].sort(), ["accounts", "messages"]);
    assert.deepEqual(recorder.notifications, []);
  });

  it("says so, and moves nothing, when the account has no Archive folder", async () => {
    const context = await harness();

    await commands.executeCommand(COMMAND_ARCHIVE, node(IMPORT_ACCOUNT, IMPORT_INBOX));

    assert.deepEqual(context.moved, []);
    assert.deepEqual(context.refreshed, []);
    assert.match(recorder.notifications.join("\n"), /no folder marked as Archive/);
  });

  it("offers every other folder of the account, and moves to the one picked", async () => {
    const context = await harness();
    recorder.answerQuickPick("Papierkorb");

    await commands.executeCommand(COMMAND_MOVE_TO, node(OUTLOOK_ACCOUNT, OUTLOOK_INBOX));

    const offered = recorder.quickPicks[0] ?? [];
    assert.ok(!offered.includes("INBOX"), "the folder it already lives in must not be offered");
    assert.ok(offered.includes("Papierkorb"), offered.join(", "));
    assert.equal(offered.length, 7);
    assert.deepEqual(context.moved, [{ messageId: 4213, toFolderId: 205 }]);
  });

  it("offers the roles in sidebar order, so Trash and Archive are where the eye expects", async () => {
    await harness();
    recorder.answerQuickPick(undefined);

    await commands.executeCommand(COMMAND_MOVE_TO, node(OUTLOOK_ACCOUNT, OUTLOOK_INBOX));

    assert.deepEqual((recorder.quickPicks[0] ?? []).slice(0, 4), ["Drafts", "Sent", "Papierkorb", "Junk"]);
  });

  it("moves nothing when the picker is dismissed", async () => {
    const context = await harness();

    await commands.executeCommand(COMMAND_MOVE_TO, node(OUTLOOK_ACCOUNT, OUTLOOK_INBOX));

    assert.deepEqual(context.moved, []);
    assert.deepEqual(context.refreshed, []);
  });

  /** The hostile name lives on account 1 in the fixture, so this must file from that account or it
   * asserts nothing at all. */
  it("hardens a folder name the server chose before it becomes a picker label", async () => {
    await harness("accountsHostileLabels");
    recorder.answerQuickPick(undefined);

    await commands.executeCommand(COMMAND_MOVE_TO, node(IMPORT_ACCOUNT, IMPORT_INBOX));

    const offered = recorder.quickPicks[0] ?? [];
    assert.equal(offered.length, 1, offered.join(", "));
    for (const label of offered) {
      const smuggled = [...label].find((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 0x20 || (point >= 0x200b && point <= 0x200f) || (point >= 0x202a && point <= 0x202e);
      });
      assert.equal(smuggled, undefined, JSON.stringify(label));
    }
  });

  it("says nothing can be picked when the account has only the folder it is in", async () => {
    const context = await harness();

    await commands.executeCommand(COMMAND_MOVE_TO, node(IMPORT_ACCOUNT, IMPORT_INBOX));

    assert.deepEqual(context.moved, []);
    assert.match(recorder.notifications.join("\n"), /no other folder/);
  });

  it("asks for a message when invoked with nothing selected", async () => {
    const context = await harness();

    await commands.executeCommand(COMMAND_ARCHIVE, undefined);

    assert.deepEqual(context.moved, []);
    assert.equal(recorder.quickPicks.length, 0);
    assert.ok(recorder.notifications.length > 0);
  });
});

describe("choosing where a message can go", () => {
  const folders: readonly FolderDto[] = [
    { id: 1, accountId: 2, name: "Zeta", unread: 0, total: 0 },
    { id: 2, accountId: 2, name: "INBOX", role: "inbox", unread: 0, total: 0 },
    { id: 3, accountId: 2, name: "Alpha", unread: 0, total: 0 },
    { id: 4, accountId: 2, name: "Papierkorb", role: "trash", unread: 0, total: 0 },
  ];

  it("finds a role whatever case the server used", () => {
    assert.equal(folderWithRole(folders, "trash")?.id, 4);
    assert.equal(folderWithRole(folders, "TRASH")?.id, 4);
    assert.equal(folderWithRole(folders, "archive"), undefined);
  });

  it("leaves out the folder the message is already in", () => {
    assert.deepEqual(
      moveTargets(folders, 2).map((folder) => folder.name),
      ["Papierkorb", "Alpha", "Zeta"],
    );
  });

  it("orders roles first and then alphabetically", () => {
    assert.deepEqual(
      moveTargets(folders, 99).map((folder) => folder.name),
      ["INBOX", "Papierkorb", "Alpha", "Zeta"],
    );
  });
});
