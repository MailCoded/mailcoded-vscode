import * as vscode from "vscode";

import { explain } from "../daemon/errors.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import type { DaemonStatus } from "../daemon/types.js";

export const COMMAND_SHOW_DAEMON_LOG = "mailcoded.showDaemonLog";
export const COMMAND_SHOW_DAEMON_INFO = "mailcoded.showDaemonInfo";
export const COMMAND_RESTART_DAEMON = "mailcoded.restartDaemon";

const SHOW_LOG = "Show Daemon Log";

function connected(status: DaemonStatus): status is Extract<DaemonStatus, { state: "ready" | "secondary" }> {
  return status.state === "ready" || status.state === "secondary";
}

function describe(status: DaemonStatus): string {
  const detail = status.detail;
  return `The mailcoded daemon is ${status.state}.${detail === undefined ? "" : ` ${detail}`}`;
}

async function offerLog(supervisor: MailcodedDaemonSupervisor, message: string, warn: boolean): Promise<void> {
  const chosen = warn
    ? await vscode.window.showWarningMessage(message, SHOW_LOG)
    : await vscode.window.showInformationMessage(message, SHOW_LOG);
  if (chosen === SHOW_LOG) {
    supervisor.output.show(true);
  }
}

async function restartDaemon(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Restarting the mailcoded daemon" },
      () => supervisor.restart(),
    );
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Restarting the daemon" }).text, true);
    return;
  }

  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), true);
  }
}

async function showDaemonInfo(supervisor: MailcodedDaemonSupervisor): Promise<void> {
  const status = supervisor.status;
  if (!connected(status)) {
    await offerLog(supervisor, describe(status), false);
    return;
  }

  let accounts: number;
  try {
    accounts = (await supervisor.client.accountList()).length;
  } catch (error: unknown) {
    await offerLog(supervisor, explain(error, { operation: "Reading the account list" }).text, true);
    return;
  }

  const { capabilities } = status;
  const parts = [
    `Daemon ${status.daemonVersion}`,
    `${String(capabilities.methods.length)} methods`,
    `max search ${String(capabilities.maxSearchLimit)}`,
    `${String(accounts)} ${accounts === 1 ? "account" : "accounts"}`,
  ];
  if (status.state === "secondary") {
    parts.push("secondary instance, no notifications");
  }

  await offerLog(supervisor, parts.join(" · "), false);
}

/** Only the three commands that mean something before there is a mail UI; a registered no-op
 * command is worse than an absent one, so the rest of the manifest waits for its phase. */
export function registerCommands(supervisor: MailcodedDaemonSupervisor): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_LOG, () => {
      supervisor.output.show(true);
    }),
    vscode.commands.registerCommand(COMMAND_SHOW_DAEMON_INFO, () => showDaemonInfo(supervisor)),
    vscode.commands.registerCommand(COMMAND_RESTART_DAEMON, () => restartDaemon(supervisor)),
  );
}
