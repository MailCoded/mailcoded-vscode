import assert from "node:assert/strict";

import type { AccountDto, FolderDto } from "../../src/protocol/index.js";
import type { AccountNode, FolderNode } from "../../src/model/folderTree.js";
import { accountKey, buildFolderTree, folderKey, folderNodeKind } from "../../src/model/folderTree.js";

const LOCAL: AccountDto = {
  id: 1,
  email: "local@import.mailcoded.test",
  provider: "imap",
  auth: "password",
  quirks: [],
};

const OUTLOOK: AccountDto = {
  id: 2,
  email: "someone@outlook.com",
  provider: "graph",
  auth: "oauth2",
  quirks: [],
};

interface FolderOptions {
  role?: string;
  unread?: number;
  total?: number;
  accountId?: number;
}

let nextId = 100;

function folder(name: string, options: FolderOptions = {}): FolderDto {
  const base: FolderDto = {
    id: nextId++,
    accountId: options.accountId ?? LOCAL.id,
    name,
    unread: options.unread ?? 0,
    total: options.total ?? 0,
  };
  return options.role === undefined ? base : { ...base, role: options.role };
}

function labels(nodes: readonly FolderNode[]): string[] {
  return nodes.map((node) => node.label);
}

function flatten(nodes: readonly FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function find(tree: AccountNode, path: string): FolderNode {
  const hit = flatten(tree.children).find((node) => node.path === path);
  assert.ok(hit !== undefined, `no node at path "${path}"`);
  return hit;
}

describe("buildFolderTree ordering", () => {
  it("puts special-use roles first in the Navigation order, then the rest alphabetically", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("Zebra"),
      folder("All Mail", { role: "all" }),
      folder("Junk Email", { role: "junk" }),
      folder("apples"),
      folder("Archive", { role: "archive" }),
      folder("Sent Items", { role: "sent" }),
      folder("INBOX", { role: "inbox" }),
      folder("Deleted Items", { role: "trash" }),
      folder("Drafts", { role: "drafts" }),
    ]);

    assert.deepEqual(labels(tree.children), [
      "INBOX",
      "Drafts",
      "Sent Items",
      "Deleted Items",
      "Junk Email",
      "Archive",
      "All Mail",
      "apples",
      "Zebra",
    ]);
  });

  it("ranks a trash folder the server calls 'Papierkorb' where trash goes", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("Trash"),
      folder("Papierkorb", { role: "trash" }),
      folder("INBOX", { role: "inbox" }),
      folder("Archiv", { role: "archive" }),
      folder("AAA"),
    ]);

    assert.deepEqual(labels(tree.children), ["INBOX", "Papierkorb", "Archiv", "AAA", "Trash"]);
  });

  it("treats a name-only 'Trash' as an ordinary folder and an unknown role as none", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("beta", { role: "important" }),
      folder("Alpha"),
      folder("INBOX", { role: "inbox" }),
    ]);

    assert.deepEqual(labels(tree.children), ["INBOX", "Alpha", "beta"]);
  });

  it("orders non-role folders case-insensitively, not by ASCII case", () => {
    const tree = buildFolderTree(LOCAL, [folder("banana"), folder("Apple"), folder("cherry"), folder("BLUEBERRY")]);

    assert.deepEqual(labels(tree.children), ["Apple", "banana", "BLUEBERRY", "cherry"]);
  });

  it("applies the same ordering inside a subtree", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("Work"),
      folder("Work/zeta"),
      folder("Work/Archive", { role: "archive" }),
      folder("Work/alpha"),
    ]);

    assert.deepEqual(labels(find(tree, "Work").children), ["Archive", "alpha", "zeta"]);
  });
});

describe("buildFolderTree nesting", () => {
  it("splits on '/' so a delimiter never survives as a literal in a label", () => {
    const tree = buildFolderTree(LOCAL, [folder("Projects/Alpha/Notes", { total: 3 })]);

    for (const node of flatten(tree.children)) {
      assert.ok(!node.label.includes("/"), `label "${node.label}" kept a delimiter`);
    }
    assert.deepEqual(
      flatten(tree.children).map((node) => node.path),
      ["Projects", "Projects/Alpha", "Projects/Alpha/Notes"],
    );
    assert.equal(find(tree, "Projects/Alpha/Notes").label, "Notes");
  });

  it("invents a phantom group for a parent segment the server never listed", () => {
    const tree = buildFolderTree(LOCAL, [folder("Projects/Alpha", { unread: 2, total: 9 })]);

    assert.equal(tree.children.length, 1);
    const projects = find(tree, "Projects");
    assert.equal(projects.folder, undefined);
    assert.equal(projects.role, undefined);
    assert.equal(folderNodeKind(projects), "group");
    assert.equal(projects.key, folderKey(LOCAL.id, "Projects"));

    const alpha = find(tree, "Projects/Alpha");
    assert.ok(alpha.folder !== undefined);
    assert.equal(folderNodeKind(alpha), "folder");
    assert.equal(alpha.children.length, 0);
  });

  it("fills in a phantom parent later listed by the server", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("Projects/Alpha", { total: 4 }),
      folder("Projects", { role: "archive", total: 1 }),
    ]);

    const projects = find(tree, "Projects");
    assert.ok(projects.folder !== undefined);
    assert.equal(projects.role, "archive");
    assert.equal(folderNodeKind(projects), "folder");
  });

  it("ignores empty segments from a leading, trailing or doubled delimiter", () => {
    const tree = buildFolderTree(LOCAL, [folder("/INBOX/", { role: "inbox" }), folder("Work//Reports")]);

    assert.deepEqual(labels(tree.children), ["INBOX", "Work"]);
    assert.equal(find(tree, "Work/Reports").label, "Reports");
  });

  it("nests siblings under one shared parent", () => {
    const tree = buildFolderTree(LOCAL, [folder("Work/Beta"), folder("Work/Alpha"), folder("Work")]);

    assert.equal(tree.children.length, 1);
    assert.deepEqual(labels(find(tree, "Work").children), ["Alpha", "Beta"]);
  });
});

describe("buildFolderTree counts", () => {
  it("rolls unread and total up from descendants to the parent and the account", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("INBOX", { role: "inbox", unread: 4, total: 37 }),
      folder("Projects", { unread: 2, total: 5 }),
      folder("Projects/Alpha", { unread: 3, total: 10 }),
      folder("Projects/Alpha/Deep", { unread: 1, total: 2 }),
      folder("Projects/Beta", { unread: 0, total: 4 }),
    ]);

    assert.deepEqual(
      { unread: find(tree, "Projects/Alpha").unread, total: find(tree, "Projects/Alpha").total },
      { unread: 4, total: 12 },
    );
    assert.deepEqual(
      { unread: find(tree, "Projects").unread, total: find(tree, "Projects").total },
      { unread: 6, total: 21 },
    );
    assert.deepEqual({ unread: tree.unread, total: tree.total }, { unread: 10, total: 58 });
  });

  it("counts a phantom group as its descendants and nothing of its own", () => {
    const tree = buildFolderTree(LOCAL, [
      folder("Projects/Alpha", { unread: 1, total: 6 }),
      folder("Projects/Beta", { unread: 2, total: 7 }),
    ]);

    const projects = find(tree, "Projects");
    assert.equal(projects.folder, undefined);
    assert.deepEqual({ unread: projects.unread, total: projects.total }, { unread: 3, total: 13 });
    assert.deepEqual({ unread: tree.unread, total: tree.total }, { unread: 3, total: 13 });
  });

  it("counts each listed folder exactly once at the account", () => {
    const folders = [
      folder("INBOX", { role: "inbox", unread: 4, total: 37 }),
      folder("A/B", { unread: 1, total: 2 }),
      folder("A/B/C", { unread: 5, total: 8 }),
    ];
    const tree = buildFolderTree(LOCAL, folders);

    assert.equal(
      tree.total,
      folders.reduce((running, entry) => running + entry.total, 0),
    );
    assert.equal(
      tree.unread,
      folders.reduce((running, entry) => running + entry.unread, 0),
    );
  });
});

describe("buildFolderTree keys", () => {
  it("derives stable keys that survive a reload with a different arrival order", () => {
    const build = (folders: readonly FolderDto[]): string[] =>
      flatten(buildFolderTree(LOCAL, folders).children).map((node) => node.key);

    const first = build([folder("INBOX", { role: "inbox" }), folder("Projects/Alpha"), folder("Zebra")]);
    const second = build([folder("Zebra"), folder("Projects/Alpha"), folder("INBOX", { role: "inbox" })]);

    assert.deepEqual(first, second);
    assert.deepEqual(first, [
      "a:1/f:INBOX",
      "a:1/f:Projects",
      "a:1/f:Projects/Alpha",
      "a:1/f:Zebra",
    ]);
  });

  it("keeps keys stable when counts change underneath a folder", () => {
    const cold = buildFolderTree(LOCAL, [folder("INBOX", { role: "inbox", unread: 0, total: 37 })]);
    const warm = buildFolderTree(LOCAL, [folder("INBOX", { role: "inbox", unread: 9, total: 46 })]);

    assert.deepEqual(
      flatten(cold.children).map((node) => node.key),
      flatten(warm.children).map((node) => node.key),
    );
  });

  it("separates accounts, so the same folder name never collides", () => {
    const local = buildFolderTree(LOCAL, [folder("INBOX", { role: "inbox" })]);
    const outlook = buildFolderTree(OUTLOOK, [folder("INBOX", { role: "inbox", accountId: OUTLOOK.id })]);

    assert.equal(local.key, accountKey(LOCAL.id));
    assert.equal(outlook.key, "a:2");
    assert.notEqual(local.children[0]?.key, outlook.children[0]?.key);
    assert.equal(outlook.children[0]?.accountId, OUTLOOK.id);
  });
});

describe("buildFolderTree shapes the real store", () => {
  it("handles an account the daemon lists with no folders at all", () => {
    const tree = buildFolderTree(LOCAL, []);

    assert.deepEqual(tree.children, []);
    assert.deepEqual({ unread: tree.unread, total: tree.total }, { unread: 0, total: 0 });
    assert.equal(tree.key, "a:1");
    assert.equal(tree.account, LOCAL);
  });

  it("handles the imported account's single INBOX of 37 messages", () => {
    const inbox = folder("INBOX", { role: "inbox", unread: 37, total: 37 });
    const tree = buildFolderTree(LOCAL, [inbox]);

    assert.equal(tree.children.length, 1);
    const node = tree.children[0];
    assert.ok(node !== undefined);
    assert.deepEqual(
      { label: node.label, path: node.path, role: node.role, key: node.key },
      { label: "INBOX", path: "INBOX", role: "inbox", key: "a:1/f:INBOX" },
    );
    assert.equal(node.folder, inbox);
    assert.deepEqual({ unread: tree.unread, total: tree.total }, { unread: 37, total: 37 });
  });

  it("does not mutate or reorder the caller's array", () => {
    const folders = [folder("Zebra"), folder("INBOX", { role: "inbox" })];
    const snapshot = [...folders];

    buildFolderTree(LOCAL, folders);

    assert.deepEqual(folders, snapshot);
  });
});
