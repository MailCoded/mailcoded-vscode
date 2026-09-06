import * as vscode from "vscode";

import type { DaemonState, DaemonStatus } from "./daemon/types.js";
import type { CapabilitiesDto } from "./protocol/index.js";

export const CONTEXT_STATE = "mailcoded.state";
export const CONTEXT_TRUSTED = "mailcoded.trusted";
export const CONTEXT_CAN_SEND = "mailcoded.canSend";

/** The manifest's `viewsWelcome` also tests `noAccounts`, which no daemon state carries. */
export type ContextState = DaemonState | "noAccounts";

export const SEND_METHODS = ["send.preview", "send"] as const;

export function canSend(capabilities: CapabilitiesDto | undefined): boolean {
  if (capabilities === undefined) {
    return false;
  }
  const methods = capabilities.methods;
  return SEND_METHODS.every((method) => methods.includes(method));
}

export function contextState(status: DaemonStatus, accountCount: number | undefined): ContextState {
  const connected = status.state === "ready" || status.state === "secondary";
  return connected && accountCount === 0 ? "noAccounts" : status.state;
}

export class ContextKeys implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly published = new Map<string, string | boolean>();
  private status: DaemonStatus = { state: "stopped" };
  private accountCount: number | undefined;

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.apply();
      }),
    );
    this.apply();
  }

  setStatus(status: DaemonStatus): void {
    this.status = status;
    this.apply();
  }

  setAccountCount(count: number | undefined): void {
    this.accountCount = count;
    this.apply();
  }

  private apply(): void {
    const capabilities =
      this.status.state === "ready" || this.status.state === "secondary"
        ? this.status.capabilities
        : undefined;
    this.set(CONTEXT_STATE, contextState(this.status, this.accountCount));
    this.set(CONTEXT_TRUSTED, vscode.workspace.isTrusted);
    this.set(CONTEXT_CAN_SEND, canSend(capabilities));
  }

  private set(key: string, value: string | boolean): void {
    if (this.published.get(key) === value) {
      return;
    }
    this.published.set(key, value);
    void vscode.commands.executeCommand("setContext", key, value);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.published.clear();
  }
}
