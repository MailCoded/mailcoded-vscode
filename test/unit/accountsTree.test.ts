import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as vscode from "vscode";

import type { DaemonStatus, DaemonSupervisor } from "../../src/daemon/types.js";
import { delay, describeUnknown, startSupervisor, teardown, testLogger, waitFor } from "./harness.test.js";

type TreeNode = object;

type TreeChangeEvent = (
  listener: (changed: TreeNode | readonly TreeNode[] | undefined | null) => void,
) => { dispose(): void };

interface TreeProvider {
  getChildren(element?: TreeNode): readonly TreeNode[] | undefined | Thenable<readonly TreeNode[] | undefined>;
  getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem>;
  readonly onDidChangeTreeData?: TreeChangeEvent;
  refresh?: () => void;
  dispose?: () => void;
}

const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

const LOCAL_EMAIL = "local@import.mailcoded.test";
const OUTLOOK_EMAIL = "outlook.user@outlook.test";

/** Mirrors the `accounts` scenario in test/mock-daemon/scenarios.mjs: [unread, total] per folder. */
const LOCAL_COUNTS: readonly (readonly [number, number])[] = [[5, 37]];
const OUTLOOK_COUNTS: readonly (readonly [number, number])[] = [
  [12, 240],
  [0, 1804],
  [1, 3],
  [0, 512],
  [0, 64],
  [7, 19],
  [2, 8],
  [3, 96],
];

const ESC = String.fromCodePoint(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const HOSTILE_FOLDER_NAME = `${ESC}[31mAlerts${BIDI_OVERRIDE}gnp.txt${ZERO_WIDTH_SPACE}`;

function totals(counts: readonly (readonly [number, number])[]): { unread: number; total: number } {
  let unread = 0;
  let total = 0;
  for (const [folderUnread, folderTotal] of counts) {
    unread += folderUnread;
    total += folderTotal;
  }
  return { unread, total };
}

function sourceFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) found.push(full);
    }
  };
  walk(SRC_DIR);
  return found
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("getChildren") && text.includes("getTreeItem");
    })
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function rank(file: string): number {
  const name = path.basename(file).toLowerCase();
  if (name.includes("account")) return 0;
  if (name.includes("tree")) return 1;
  return 2;
}

function argumentShapes(supervisor: DaemonSupervisor): readonly (readonly unknown[])[] {
  const logger = testLogger();
  return [[supervisor], [{ supervisor }], [supervisor, logger], [{ supervisor, logger, output: logger }]];
}

function construct(factory: unknown, args: readonly unknown[]): unknown {
  if (typeof factory !== "function") return undefined;
  if (/^\s*class\s/.test(Function.prototype.toString.call(factory))) {
    const constructable = factory as new (...rest: readonly unknown[]) => unknown;
    return new constructable(...args);
  }
  return (factory as (...rest: readonly unknown[]) => unknown)(...args);
}

function isProviderLike(value: unknown): value is TreeProvider {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<"getChildren" | "getTreeItem", unknown>>;
  return typeof candidate.getChildren === "function" && typeof candidate.getTreeItem === "function";
}

function release(provider: TreeProvider): void {
  try {
    provider.dispose?.();
  } catch {
    // a half-built probe must not fail the test that discarded it
  }
}

interface ResolvedProvider {
  readonly file: string;
  readonly exportName: string;
  readonly shape: number;
}

let resolved: ResolvedProvider | undefined;

async function instantiate(
  file: string,
  exportName: string,
  shape: number,
  supervisor: DaemonSupervisor,
): Promise<TreeProvider | undefined> {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const args = argumentShapes(supervisor)[shape];
  if (args === undefined) return undefined;
  const instance = construct(module[exportName], args);
  return isProviderLike(instance) ? instance : undefined;
}

/** Resolved at run time so the suite names a missing provider instead of failing to load. */
async function createProvider(supervisor: DaemonSupervisor): Promise<TreeProvider> {
  if (resolved !== undefined) {
    const known = await instantiate(resolved.file, resolved.exportName, resolved.shape, supervisor);
    if (known !== undefined) return known;
  }

  const files = sourceFiles();
  const tried: string[] = [];

  for (const file of files) {
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (cause: unknown) {
      tried.push(`${path.relative(SRC_DIR, file)}: ${describeUnknown(cause)}`);
      continue;
    }

    for (const exportName of Object.keys(module)) {
      if (typeof module[exportName] !== "function") continue;
      const shapes = argumentShapes(supervisor);
      for (let shape = 0; shape < shapes.length; shape += 1) {
        let instance: unknown;
        try {
          instance = construct(module[exportName], shapes[shape] ?? []);
        } catch {
          continue;
        }
        if (!isProviderLike(instance)) continue;
        let roots: readonly TreeNode[] | undefined;
        try {
          roots = await instance.getChildren();
        } catch (cause: unknown) {
          tried.push(`${exportName} (shape ${shape}): ${describeUnknown(cause)}`);
          release(instance);
          continue;
        }
        if (roots === undefined || roots.length === 0) {
          release(instance);
          continue;
        }
        resolved = { file, exportName, shape };
        return instance;
      }
    }
  }

  throw new Error(
    "no accounts tree provider under src/ answered getChildren() with any account; " +
      `scanned [${files.map((file) => path.relative(SRC_DIR, file)).join(", ")}]` +
      (tried.length === 0 ? "" : `; attempts: ${tried.join(" | ")}`),
  );
}

interface StartedTree {
  readonly supervisor: DaemonSupervisor;
  readonly provider: TreeProvider;
  request(method: "watch.subscribe", params: { accountId: number; folderIds: readonly number[] }): Promise<unknown>;
}

const CONNECTED: readonly DaemonStatus["state"][] = ["ready", "secondary"];

async function startTree(scenario: string, states: readonly DaemonStatus["state"][] = CONNECTED): Promise<StartedTree> {
  const started = await startSupervisor(scenario, { waitFor: states });
  const provider = await createProvider(started.supervisor);
  return {
    supervisor: started.supervisor,
    provider,
    request: (method, params) => started.client().request(method, params),
  };
}

async function childrenOf(provider: TreeProvider, element?: TreeNode): Promise<readonly TreeNode[]> {
  const children = await provider.getChildren(element);
  return children ?? [];
}

function labelText(item: vscode.TreeItem): string {
  const label = item.label;
  if (typeof label === "string") return label;
  if (label !== undefined && typeof label === "object") return String(label.label);
  return "";
}

async function labelsOf(provider: TreeProvider, nodes: readonly TreeNode[]): Promise<readonly string[]> {
  const labels: string[] = [];
  for (const node of nodes) labels.push(labelText(await provider.getTreeItem(node)));
  return labels;
}

async function accountNamed(provider: TreeProvider, email: string): Promise<TreeNode> {
  const roots = await childrenOf(provider);
  const labels = await labelsOf(provider, roots);
  const at = labels.indexOf(email);
  const found = roots[at];
  assert.ok(found !== undefined, `no account row labelled '${email}'; saw [${labels.join(", ")}]`);
  return found;
}

function numberField(node: TreeNode, key: string): number | undefined {
  const record = node as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "number") return direct;
  const inner = record["node"];
  if (typeof inner !== "object" || inner === null) return undefined;
  const nested = (inner as Record<string, unknown>)[key];
  return typeof nested === "number" ? nested : undefined;
}

/** The node's own counts when it carries them, else whatever the row renders beside the label. */
function countsOf(node: TreeNode, item: vscode.TreeItem): { unread: number; total: number } {
  const unread = numberField(node, "unread");
  const total = numberField(node, "total");
  if (unread !== undefined && total !== undefined) return { unread, total };

  const rendered = typeof item.description === "string" ? item.description : "";
  const pair = /(\d+)\s*\/\s*(\d+)/.exec(rendered);
  if (pair !== null) return { unread: Number(pair[1]), total: Number(pair[2]) };
  const single = /(\d+)/.exec(rendered);
  return { unread: unread ?? 0, total: single === null ? (total ?? 0) : Number(single[1]) };
}

async function keyOf(provider: TreeProvider, node: TreeNode): Promise<string> {
  const key = (node as Record<string, unknown>)["key"];
  if (typeof key === "string" && key !== "") return key;
  const item = await provider.getTreeItem(node);
  return item.id ?? labelText(item);
}

interface Row {
  readonly node: TreeNode;
  readonly item: vscode.TreeItem;
  readonly depth: number;
}

async function walk(provider: TreeProvider, element?: TreeNode, depth = 0): Promise<readonly Row[]> {
  const rows: Row[] = [];
  for (const node of await childrenOf(provider, element)) {
    rows.push({ node, item: await provider.getTreeItem(node), depth });
    if (depth < 4) rows.push(...(await walk(provider, node, depth + 1)));
  }
  return rows;
}

/** What the row actually shows: an id is never painted, so it is not part of this check. */
function renderedStrings(item: vscode.TreeItem): readonly string[] {
  const strings: string[] = [labelText(item)];
  if (typeof item.description === "string") strings.push(item.description);
  const tooltip: unknown = item.tooltip;
  if (typeof tooltip === "string") strings.push(tooltip);
  else if (typeof tooltip === "object" && tooltip !== null) {
    const value = (tooltip as Record<string, unknown>)["value"];
    if (typeof value === "string") strings.push(value);
  }
  return strings;
}

describe("accounts tree", () => {
  afterEach(teardown);

  it("lists every account at the root, labelled by email", async () => {
    const tree = await startTree("accounts");

    const roots = await childrenOf(tree.provider);
    assert.equal(roots.length, 2, "both accounts must be root rows");
    assert.deepEqual(await labelsOf(tree.provider, roots), [LOCAL_EMAIL, OUTLOOK_EMAIL]);
  });

  it("renders folders in role order, with a phantom parent and a renamed trash in place", async () => {
    const tree = await startTree("accounts");

    const outlook = await accountNamed(tree.provider, OUTLOOK_EMAIL);
    const folders = await childrenOf(tree.provider, outlook);

    assert.deepEqual(await labelsOf(tree.provider, folders), [
      "INBOX",
      "Drafts",
      "Sent",
      "Papierkorb",
      "Junk",
      "Archive",
      "Newsletters",
      "Projects",
    ]);

    const projects = folders[7];
    assert.ok(projects !== undefined);
    assert.deepEqual(await labelsOf(tree.provider, await childrenOf(tree.provider, projects)), ["Alpha"]);

    const local = await accountNamed(tree.provider, LOCAL_EMAIL);
    assert.deepEqual(await labelsOf(tree.provider, await childrenOf(tree.provider, local)), ["INBOX"]);
  });

  it("rolls each account's unread and total up from its folders", async () => {
    const tree = await startTree("accounts");

    for (const [email, counts] of [
      [LOCAL_EMAIL, LOCAL_COUNTS],
      [OUTLOOK_EMAIL, OUTLOOK_COUNTS],
    ] as const) {
      const account = await accountNamed(tree.provider, email);
      const expected = totals(counts);
      const actual = countsOf(account, await tree.provider.getTreeItem(account));
      assert.deepEqual(actual, expected, `${email} must total its folders`);

      let unread = 0;
      let total = 0;
      for (const folder of await childrenOf(tree.provider, account)) {
        const row = countsOf(folder, await tree.provider.getTreeItem(folder));
        unread += row.unread;
        total += row.total;
      }
      assert.deepEqual({ unread, total }, expected, `${email}'s rows must add up to its account row`);
    }
  });

  it("keeps tree item ids stable across a refresh", async () => {
    const tree = await startTree("accounts");
    assert.equal(typeof tree.provider.refresh, "function", "the view needs a refresh(): a secondary sends no notifications");

    const before = (await walk(tree.provider)).map((row) => row.item.id);
    assert.ok(before.length >= 10, `expected the whole tree, saw ${before.length} rows`);
    assert.ok(
      before.every((id) => typeof id === "string" && id !== ""),
      "every row needs an id, or VS Code loses selection and expansion on refresh",
    );
    assert.equal(new Set(before).size, before.length, "ids must be unique");

    tree.provider.refresh?.();
    const after = (await walk(tree.provider)).map((row) => row.item.id);
    assert.deepEqual(after, before);
  });

  it("scopes a folder update to that element instead of refreshing the whole tree", async () => {
    const tree = await startTree("accounts", ["ready"]);
    const outlook = await accountNamed(tree.provider, OUTLOOK_EMAIL);
    await childrenOf(tree.provider, outlook);

    const subscribe = tree.provider.onDidChangeTreeData;
    assert.equal(typeof subscribe, "function", "the view must expose onDidChangeTreeData");

    const fired: (TreeNode | readonly TreeNode[] | undefined | null)[] = [];
    subscribe?.((changed) => fired.push(changed));

    await tree.request("watch.subscribe", { accountId: 2, folderIds: [201] });
    await waitFor(() => fired.length > 0, "a change event for the updated folder");
    await delay(150);

    for (const change of fired) {
      assert.ok(change !== undefined && change !== null, "a folder update must not redraw the whole tree");
      const elements = Array.isArray(change) ? (change as readonly TreeNode[]) : [change as TreeNode];
      assert.ok(elements.length > 0, "an empty change is a full refresh in disguise");
      for (const element of elements) {
        const key = await keyOf(tree.provider, element);
        assert.match(key, /(^|[^0-9])2([^0-9]|$)/, `the change must name a row of account 2, got '${key}'`);
      }
    }
  });

  it("keeps the healthy account when the other account's folders fail", async () => {
    const tree = await startTree("accountsPartialFailure");

    const roots = await childrenOf(tree.provider);
    assert.deepEqual(await labelsOf(tree.provider, roots), [LOCAL_EMAIL, OUTLOOK_EMAIL]);

    const broken = await accountNamed(tree.provider, OUTLOOK_EMAIL);
    const brokenChildren = await childrenOf(tree.provider, broken);
    assert.ok(brokenChildren.length <= 1, `a 1002 must not invent folders, saw ${brokenChildren.length}`);

    const healthy = await accountNamed(tree.provider, LOCAL_EMAIL);
    assert.deepEqual(await labelsOf(tree.provider, await childrenOf(tree.provider, healthy)), ["INBOX"]);
  });

  it("renders a hostile folder name inert", async () => {
    const tree = await startTree("accountsHostileLabels");

    const rows = await walk(tree.provider);
    const labels = rows.map((row) => labelText(row.item));
    assert.ok(
      labels.some((label) => label.includes("Alerts")),
      `the hostile folder must still be listed, saw [${labels.join(", ")}]`,
    );

    for (const row of rows) {
      for (const rendered of renderedStrings(row.item)) {
        assert.ok(!rendered.includes(ESC), `an ESC survived into '${JSON.stringify(rendered)}'`);
        assert.ok(!rendered.includes(BIDI_OVERRIDE), `a U+202E survived into '${JSON.stringify(rendered)}'`);
        assert.ok(!rendered.includes(ZERO_WIDTH_SPACE), `a U+200B survived into '${JSON.stringify(rendered)}'`);
      }
    }

    assert.ok(HOSTILE_FOLDER_NAME.includes(ESC), "the scenario input must carry the raw code points");
  });

  it("answers getChildren even after the client starts throwing", async () => {
    const tree = await startTree("accounts");
    const roots = await childrenOf(tree.provider);
    const outlook = await accountNamed(tree.provider, OUTLOOK_EMAIL);

    tree.supervisor.dispose();
    await waitFor(() => tree.supervisor.status.state === "stopped", "the supervisor to stop");

    assert.ok(Array.isArray(await childrenOf(tree.provider)), "the root must still answer");
    assert.ok(Array.isArray(await childrenOf(tree.provider, outlook)), "an expanded account must still answer");
    tree.provider.refresh?.();
    assert.ok(Array.isArray(await childrenOf(tree.provider)), "a refresh against a dead client must still answer");
    assert.equal(roots.length, 2);
  });

  it("renders both accounts while the daemon is a secondary", async () => {
    const tree = await startTree("accountsSecondary", ["secondary"]);

    assert.deepEqual(await labelsOf(tree.provider, await childrenOf(tree.provider)), [LOCAL_EMAIL, OUTLOOK_EMAIL]);
    const outlook = await accountNamed(tree.provider, OUTLOOK_EMAIL);
    assert.equal((await childrenOf(tree.provider, outlook)).length, 8);
  });
});
