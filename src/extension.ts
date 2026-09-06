import * as vscode from "vscode";

import { registerCommands } from "./commands/index.js";
import { createDaemonSupervisor } from "./daemon/supervisor.js";
import type { MailcodedDaemonSupervisor } from "./daemon/supervisor.js";
import type { DaemonStatus } from "./daemon/types.js";
import { ContextKeys } from "./context.js";

export interface MailcodedApi {
  readonly supervisor: MailcodedDaemonSupervisor;
  readonly _test?: {
    readonly contextKeys: ContextKeys;
  };
}

let active: MailcodedDaemonSupervisor | undefined;

function trackAccounts(supervisor: MailcodedDaemonSupervisor, keys: ContextKeys, status: DaemonStatus): void {
  keys.setStatus(status);
  if (status.state !== "ready" && status.state !== "secondary") {
    keys.setAccountCount(undefined);
    return;
  }
  supervisor.client.accountList().then(
    (accounts) => {
      keys.setAccountCount(accounts.length);
    },
    () => {
      keys.setAccountCount(undefined);
    },
  );
}

export function activate(context: vscode.ExtensionContext): MailcodedApi {
  const supervisor = createDaemonSupervisor(context);
  active = supervisor;

  const keys = new ContextKeys();
  context.subscriptions.push(supervisor, keys);
  context.subscriptions.push(
    supervisor.onDidChangeStatus((status) => {
      trackAccounts(supervisor, keys, status);
    }),
  );
  context.subscriptions.push(registerCommands(supervisor));

  // Activation must not wait on a spawn or a handshake; the status event reports the outcome.
  void supervisor.start();

  return process.env["MAILCODED_TEST"] === "1"
    ? { supervisor, _test: { contextKeys: keys } }
    : { supervisor };
}

export function deactivate(): Thenable<void> {
  const supervisor = active;
  active = undefined;
  return supervisor === undefined ? Promise.resolve() : supervisor.stop();
}
