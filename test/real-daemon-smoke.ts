import { createDaemonSupervisor } from "../src/daemon/supervisor.js";
import { buildFolderTree } from "../src/model/folderTree.js";
import type { FolderNode } from "../src/model/folderTree.js";

const DAEMON = process.env["MAILCODED_DAEMON"] ?? "";

async function main(): Promise<void> {
  const supervisor = createDaemonSupervisor({ extensionPath: process.cwd() });
  const seen: string[] = [];
  supervisor.onDidChangeStatus((s) => seen.push(s.state));

  await supervisor.start();

  for (let i = 0; i < 100 && !["ready", "secondary", "failed", "daemonMissing", "protocolMismatch"].includes(supervisor.status.state); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const status = supervisor.status;
  process.stdout.write(`daemon      ${DAEMON}\n`);
  process.stdout.write(`state       ${status.state}\n`);
  if (status.state === "ready" || status.state === "secondary") {
    process.stdout.write(`version     ${status.daemonVersion}\n`);
    process.stdout.write(`methods     ${status.capabilities.methods.length}\n`);
    process.stdout.write(`watch       ${String(status.capabilities.watch)}\n`);
    const accounts = await supervisor.client.accountList();
    process.stdout.write(`accounts    ${accounts.length}\n`);
    for (const account of accounts) {
      const folders = await supervisor.client.folderList(account.id);
      const tree = buildFolderTree(account, folders);
      process.stdout.write(`\n  ${tree.account.email}  ${tree.unread}/${tree.total} unread/total, ${folders.length} folders\n`);
      const walk = (nodes: readonly FolderNode[], depth: number): void => {
        for (const node of nodes) {
          process.stdout.write(`    ${"  ".repeat(depth)}${node.label}  ${node.unread}/${node.total}\n`);
          walk(node.children, depth + 1);
        }
      };
      walk(tree.children, 0);
    }
  } else {
    process.stdout.write(`detail      ${status.detail ?? "(none)"}\n`);
  }
  process.stdout.write(`transitions ${seen.join(" -> ")}\n`);

  await supervisor.stop();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`smoke failed: ${String(error)}\n`);
    process.exit(1);
  },
);
