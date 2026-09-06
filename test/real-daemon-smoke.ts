import { searchMessages } from "../src/daemon/client.js";
import { createDaemonSupervisor } from "../src/daemon/supervisor.js";
import type { MailcodedClient } from "../src/daemon/types.js";
import { buildFolderTree } from "../src/model/folderTree.js";
import type { FolderNode } from "../src/model/folderTree.js";
import { hardenLine, senderLabel, shortDate } from "../src/model/messageFormat.js";
import { appendPage, emptyPage } from "../src/model/paging.js";
import type { PageState } from "../src/model/paging.js";
import { SearchOrders } from "../src/protocol/index.js";
import type { EnvelopeDto, SearchResult } from "../src/protocol/index.js";

const DAEMON = process.env["MAILCODED_DAEMON"] ?? "";
const PAGE_SIZE = 50;
const SHOWN = 5;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Exactly what a message row renders: `messageItems.ts` hardens the same three fields. */
function row(envelope: EnvelopeDto, now: Date): string {
  const subject = hardenLine(envelope.subject, 60) || "(no subject)";
  return `      ${String(envelope.id).padStart(6)}  ${subject.padEnd(60)}  ${hardenLine(
    senderLabel(envelope),
    32,
  ).padEnd(32)}  ${shortDate(envelope.date, now)}`;
}

function browse(
  client: MailcodedClient,
  accountId: number,
  folderId: number,
  cursor: string | undefined,
): Promise<SearchResult> {
  const base = {
    query: "",
    accountId,
    folderId,
    order: SearchOrders.Date,
    includeSnippet: false,
    limit: PAGE_SIZE,
  };
  return searchMessages(client, cursor === undefined ? base : { ...base, cursor });
}

/** The whole point: two pages, and nothing on the second that was already on the first. */
async function pageThroughInbox(client: MailcodedClient, accountId: number, folderId: number): Promise<void> {
  const now = new Date();

  const first = await browse(client, accountId, folderId, undefined);
  let page: PageState = appendPage(emptyPage(), first);
  write(
    `    page 1      ${String(first.hits.length)} hits, truncated=${String(first.truncated)}, ` +
      `cursor=${page.nextCursor === undefined ? "(none)" : "present"}, unreachable=${String(page.unreachable)}`,
  );
  for (const envelope of page.hits.slice(0, SHOWN)) write(row(envelope, now));

  const cursor = page.nextCursor;
  if (cursor === undefined) {
    write("    page 2      no cursor: this folder fits in one page");
    return;
  }

  const firstIds = new Set(page.hits.map((hit) => hit.id));
  const second = await browse(client, accountId, folderId, cursor);
  page = appendPage(page, second);
  const repeated = second.hits.filter((hit) => firstIds.has(hit.id)).length;
  write(
    `    page 2      ${String(second.hits.length)} hits, truncated=${String(second.truncated)}, ` +
      `cursor=${page.nextCursor === undefined ? "(none)" : "present"}, unreachable=${String(page.unreachable)}`,
  );
  for (const envelope of second.hits.slice(0, SHOWN)) write(row(envelope, now));
  write(`    overlap     ${String(repeated)} of page 2's ids were already on page 1`);
  write(`    loaded      ${String(page.hits.length)} distinct envelopes after two pages`);

  if (repeated !== 0) throw new Error(`page 2 repeated ${String(repeated)} of page 1`);
  if (page.hits.length !== first.hits.length + second.hits.length) {
    throw new Error("the two pages did not concatenate cleanly");
  }
}

async function main(): Promise<void> {
  const supervisor = createDaemonSupervisor({ extensionPath: process.cwd() });
  const seen: string[] = [];
  supervisor.onDidChangeStatus((s) => seen.push(s.state));

  await supervisor.start();

  for (let i = 0; i < 100 && !["ready", "secondary", "failed", "daemonMissing", "protocolMismatch"].includes(supervisor.status.state); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const status = supervisor.status;
  write(`daemon      ${DAEMON}`);
  write(`state       ${status.state}`);
  if (status.state === "ready" || status.state === "secondary") {
    write(`version     ${status.daemonVersion}`);
    write(`methods     ${status.capabilities.methods.length}`);
    write(`watch       ${String(status.capabilities.watch)}`);
    write(`maxSearch   ${String(status.capabilities.maxSearchLimit)}`);
    const accounts = await supervisor.client.accountList();
    write(`accounts    ${String(accounts.length)}`);
    for (const account of accounts) {
      const folders = await supervisor.client.folderList(account.id);
      const tree = buildFolderTree(account, folders);
      write(`\n  ${tree.account.email}  ${String(tree.unread)}/${String(tree.total)} unread/total, ${String(folders.length)} folders`);
      const walk = (nodes: readonly FolderNode[], depth: number): void => {
        for (const node of nodes) {
          write(`    ${"  ".repeat(depth)}${node.label}  ${String(node.unread)}/${String(node.total)}`);
          walk(node.children, depth + 1);
        }
      };
      walk(tree.children, 0);

      const inbox = folders.find((folder) => folder.role === "inbox");
      if (inbox === undefined) continue;
      write(`\n    browsing    ${account.email} ${inbox.name} (folder ${String(inbox.id)}, ${String(inbox.total)} total)`);
      await pageThroughInbox(supervisor.client, account.id, inbox.id);
    }
  } else {
    write(`detail      ${status.detail ?? "(none)"}`);
  }
  write(`\ntransitions ${seen.join(" -> ")}`);

  await supervisor.stop();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`smoke failed: ${String(error)}\n`);
    process.exit(1);
  },
);
