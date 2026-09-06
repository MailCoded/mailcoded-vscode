import * as vscode from "vscode";

import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import type { DaemonStatus } from "../daemon/types.js";
import { RpcErrorCode } from "../protocol/index.js";

export const STATUS_BAR_COMMAND = "mailcoded.sync";

export type StatusBarBackground = "none" | "warning" | "error";

export interface StatusBarPresentation {
  readonly text: string;
  readonly tooltip: string;
  readonly background: StatusBarBackground;
}

export interface MailcodedStatusBar extends vscode.Disposable {
  /** Nested syncs are counted, so the one that finishes first leaves the spinner to the other. */
  beginSync(): vscode.Disposable;
  setNeedsSignIn(needed: boolean): void;
  dispose(): void;
}

const SECONDARY_TOOLTIP =
  "Another Mailcoded window has the mail store open, so this one is a secondary. " +
  "It reads accounts, folders and mail normally, but the daemon sends it no change " +
  "notifications: new mail will not appear here on its own. Sync or refresh to pick up " +
  "changes, or close the other window and reload to make this one live.";

const SIGN_IN_TOOLTIP =
  "Signing in to a mail account failed, so Mailcoded has stopped syncing it. " +
  "Repeated attempts can lock an account, so it will not retry on its own. " +
  "Enter the password or app password again, then sync.";

const WARNING_BACKGROUND = new vscode.ThemeColor("statusBarItem.warningBackground");
const ERROR_BACKGROUND = new vscode.ThemeColor("statusBarItem.errorBackground");

function withDetail(tooltip: string, status: DaemonStatus): string {
  const detail = status.detail?.trim();
  return detail === undefined || detail.length === 0 ? tooltip : `${tooltip}\n\n${detail}`;
}

function connectedPresentation(
  status: DaemonStatus,
  syncing: boolean,
  needsSignIn: boolean,
): StatusBarPresentation {
  if (syncing) {
    return {
      text: "$(sync~spin) Syncing...",
      tooltip: withDetail("Mailcoded is syncing your mail.", status),
      background: "none",
    };
  }
  if (needsSignIn) {
    return { text: "$(warning) Mailcoded: needs sign-in", tooltip: SIGN_IN_TOOLTIP, background: "warning" };
  }
  if (status.state === "secondary") {
    return {
      text: "$(mail) Mailcoded (secondary)",
      tooltip: withDetail(SECONDARY_TOOLTIP, status),
      background: "none",
    };
  }
  return {
    text: "$(mail) Mailcoded",
    tooltip: withDetail("Mailcoded is connected. Select to sync every account.", status),
    background: "none",
  };
}

export function statusBarPresentation(
  status: DaemonStatus,
  syncing: boolean,
  needsSignIn: boolean,
): StatusBarPresentation {
  switch (status.state) {
    case "ready":
    case "secondary":
      return connectedPresentation(status, syncing, needsSignIn);

    case "restarting":
      return {
        text: "$(loading~spin) Mailcoded: reconnecting",
        tooltip: withDetail("Mailcoded is restarting the daemon.", status),
        background: "none",
      };

    case "starting":
      return {
        text: "$(loading~spin) Mailcoded: starting",
        tooltip: withDetail("Mailcoded is starting the daemon.", status),
        background: "none",
      };

    case "failed":
      return {
        text: "$(error) Mailcoded: daemon stopped",
        tooltip: withDetail("The mailcoded daemon stopped unexpectedly and mail is unavailable.", status),
        background: "error",
      };

    case "daemonMissing":
      return {
        text: "$(error) Mailcoded: daemon not found",
        tooltip: withDetail(
          "Mailcoded could not find the daemon executable. Set mailcoded.daemonPath to the binary.",
          status,
        ),
        background: "error",
      };

    case "protocolMismatch":
      return {
        text: "$(error) Mailcoded: version mismatch",
        tooltip: withDetail(
          "The daemon speaks a protocol version this extension does not. Update whichever is older.",
          status,
        ),
        background: "error",
      };

    case "stopped":
      return {
        text: "$(circle-slash) Mailcoded: not running",
        tooltip: withDetail("The mailcoded daemon is not running.", status),
        background: "none",
      };
  }
}

function backgroundColor(background: StatusBarBackground): vscode.ThemeColor | undefined {
  switch (background) {
    case "warning":
      return WARNING_BACKGROUND;
    case "error":
      return ERROR_BACKGROUND;
    case "none":
      return undefined;
  }
}

class StatusBar implements MailcodedStatusBar {
  readonly #item: vscode.StatusBarItem;
  readonly #subscriptions: { dispose(): void }[] = [];

  #status: DaemonStatus;
  #syncs = 0;
  #needsSignIn = false;

  constructor(supervisor: MailcodedDaemonSupervisor) {
    this.#status = supervisor.status;
    this.#item = vscode.window.createStatusBarItem("mailcoded.status", vscode.StatusBarAlignment.Right, 100);
    this.#item.name = "Mailcoded";
    this.#item.command = STATUS_BAR_COMMAND;

    this.#subscriptions.push(
      supervisor.onDidChangeStatus((status) => {
        this.#status = status;
        this.#render();
      }),
      supervisor.onNotification((notification) => {
        if (
          notification.method === "notify.sync.error" &&
          (notification.params.requiresUserAction || notification.params.code === RpcErrorCode.Auth)
        ) {
          this.setNeedsSignIn(true);
        }
      }),
    );

    this.#render();
    this.#item.show();
  }

  beginSync(): vscode.Disposable {
    this.#syncs += 1;
    this.#render();
    let released = false;
    return new vscode.Disposable(() => {
      if (released) {
        return;
      }
      released = true;
      this.#syncs = Math.max(0, this.#syncs - 1);
      this.#render();
    });
  }

  setNeedsSignIn(needed: boolean): void {
    if (this.#needsSignIn === needed) {
      return;
    }
    this.#needsSignIn = needed;
    this.#render();
  }

  #render(): void {
    const presentation = statusBarPresentation(this.#status, this.#syncs > 0, this.#needsSignIn);
    this.#item.text = presentation.text;
    this.#item.tooltip = presentation.tooltip;
    this.#item.backgroundColor = backgroundColor(presentation.background);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#item.dispose();
  }
}

export function createStatusBar(supervisor: MailcodedDaemonSupervisor): MailcodedStatusBar {
  return new StatusBar(supervisor);
}
