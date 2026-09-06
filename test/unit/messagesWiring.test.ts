import assert from "node:assert/strict";

import type * as vscode from "vscode";

import type { MailcodedDaemonSupervisor } from "../../src/daemon/supervisor.js";
import { documentSlug, messageIdOf } from "../../src/reader/messageDocument.js";
import { AccountsTreeProvider } from "../../src/views/accountsTree.js";
import type { FolderTreeNode, MailcodedTreeNode } from "../../src/views/accountsTree.js";
import { harden } from "../../src/views/treeItems.js";
import { startSupervisor, teardown } from "./harness.test.js";

const ESC = String.fromCodePoint(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** Mirrors HOSTILE_FOLDER_NAME in test/mock-daemon/scenarios.mjs. */
const HOSTILE_FOLDER_NAME = `${ESC}[31mAlerts${BIDI_OVERRIDE}gnp.txt${ZERO_WIDTH_SPACE}`;

const OPEN_FOLDER = "mailcoded.openFolder";

function asUri(path: string): vscode.Uri {
  return { path } as unknown as vscode.Uri;
}

function labelOf(item: vscode.TreeItem): string {
  return typeof item.label === "string" ? item.label : (item.label?.label ?? "");
}

async function accountsTree(scenario: string): Promise<AccountsTreeProvider> {
  const started = await startSupervisor(scenario, { waitFor: ["ready"] });
  return new AccountsTreeProvider(started.supervisor as unknown as MailcodedDaemonSupervisor);
}

async function descendants(
  tree: AccountsTreeProvider,
  element?: MailcodedTreeNode,
): Promise<MailcodedTreeNode[]> {
  const children = await tree.getChildren(element);
  const found: MailcodedTreeNode[] = [];
  for (const child of children) {
    found.push(child, ...(await descendants(tree, child)));
  }
  return found;
}

describe("folder rows open the message list", () => {
  afterEach(teardown);

  it("gives every real folder the open command, carrying its ids and name", async () => {
    const tree = await accountsTree("accounts");
    const rows = await descendants(tree);
    const folders = rows.filter((row): row is FolderTreeNode => row.kind === "folder");
    const withFolder = folders.filter((row) => row.node.folder !== undefined);
    assert.ok(withFolder.length >= 9, `expected the scenario's folders, saw ${String(withFolder.length)}`);

    for (const row of withFolder) {
      const item = tree.getTreeItem(row);
      const command = item.command;
      assert.equal(command?.command, OPEN_FOLDER, `'${labelOf(item)}' must open its messages`);
      assert.deepEqual(command?.arguments, [
        {
          accountId: row.accountId,
          folderId: row.node.folder?.id,
          folderName: harden(row.node.folder?.name ?? ""),
        },
      ]);
    }
    tree.dispose();
  });

  it("leaves a phantom parent row alone, because it holds no folder to list", async () => {
    const tree = await accountsTree("accounts");
    const rows = await descendants(tree);
    const groups = rows.filter((row) => row.kind === "folder" && row.node.folder === undefined);
    assert.equal(groups.length, 1, "the 'Projects' parent is listed but has no folder of its own");

    for (const group of groups) {
      assert.equal(tree.getTreeItem(group).command, undefined);
    }
    tree.dispose();
  });

  it("never puts a raw folder name in the command argument", async () => {
    const tree = await accountsTree("accountsHostileLabels");
    const rows = await descendants(tree);

    for (const row of rows) {
      const rendered = JSON.stringify(tree.getTreeItem(row).command ?? {});
      assert.ok(!rendered.includes(ESC), `an ESC survived into ${rendered}`);
      assert.ok(!rendered.includes(BIDI_OVERRIDE), `a U+202E survived into ${rendered}`);
      assert.ok(!rendered.includes(ZERO_WIDTH_SPACE), `a U+200B survived into ${rendered}`);
    }
    assert.ok(HOSTILE_FOLDER_NAME.includes(ESC), "the scenario input must carry the raw code points");
    tree.dispose();
  });
});

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

describe("neither tree ever rejects out of getChildren", () => {
  afterEach(teardown);

  it("lists nothing when the accounts it needs are unreachable and the log is dead too", async () => {
    const started = await startSupervisor("accountsPartialFailure", { waitFor: ["ready"] });
    const tree = new AccountsTreeProvider(deafened(started.supervisor));
    const roots = await tree.getChildren();
    assert.ok(roots.length > 0, "the reachable account must still render");
    for (const root of roots) {
      assert.ok(Array.isArray(await tree.getChildren(root)));
    }
    tree.dispose();
  });
});

describe("message document URIs", () => {
  it("keeps only an inert, percent-encodable slug of the subject", () => {
    const slug = documentSlug(`${ESC}[31mQuarterly${BIDI_OVERRIDE} invoice${ZERO_WIDTH_SPACE}`);
    assert.ok(!slug.includes(ESC) && !slug.includes(BIDI_OVERRIDE) && !slug.includes(ZERO_WIDTH_SPACE));
    assert.equal(encodeURIComponent(slug).includes("%25"), false, "nothing left to double-encode");
  });

  it("replaces a path separator rather than letting a subject reshape the URI", () => {
    const slug = documentSlug("../../etc/passwd?x=1#y");
    assert.ok(!slug.includes("/"), slug);
    assert.ok(!slug.includes("?") && !slug.includes("#"), slug);
  });

  it("never renders an empty document name", () => {
    assert.equal(documentSlug(undefined), "message");
    assert.equal(documentSlug("   "), "message");
  });

  it("percent-encodes a subject that is not ASCII", () => {
    assert.equal(encodeURIComponent(documentSlug("Rechnung fällig")), "Rechnung%20f%C3%A4llig");
  });

  it("reads the message id back out of the path, and only a numeric one", () => {
    assert.equal(messageIdOf(asUri("4213/Quarterly invoice.txt")), 4213);
    assert.equal(messageIdOf(asUri("/4213/Quarterly invoice.txt")), 4213);
    assert.equal(messageIdOf(asUri("4213")), 4213);
    assert.equal(messageIdOf(asUri("Quarterly/4213.txt")), undefined);
    assert.equal(messageIdOf(asUri("")), undefined);
  });
});
