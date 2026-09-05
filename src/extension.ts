import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Mailcoded Daemon");
  context.subscriptions.push(channel);
  channel.appendLine("Mailcoded activated. No daemon is started and no account is read yet.");
}

export function deactivate(): void {
  return;
}
