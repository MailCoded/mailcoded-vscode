# mailcoded-vscode

Read, search, and triage your mail inside VS Code. A client for the
[mailcoded](../mailcoded) engine.

**Status: not started.** This repository is a placeholder. Nothing here builds yet.

## What this will be

A thin client. It holds no mail logic of its own: it spawns `mailcoded-daemon` as a child
process and talks Content-Length-framed JSON-RPC 2.0 over stdio, exactly the way a language
client talks to a language server. Every safety gate lives in the engine, not here.

- Sidebar `TreeDataProvider`: accounts → saved searches → folders, with unread badges
- Threaded message list, cursor-paged 50 at a time
- Reader in a sandboxed webview: plaintext by default, sanitized HTML behind a toggle,
  remote images blocked with a per-message allow
- Compose buffer with a header block, then confirm → `send.preview` → `send`

## Constraints that are not negotiable

These come from `SPEC.md` §6 in the engine repository and exist for security reasons:

- **This extension never opens a network connection to a mail server.** Only the daemon does.
- Strict CSP on every webview, with **no remote origins, ever**. HTML mail passes through
  DOMPurify *inside* the webview before injection.
- `"extensionKind": ["workspace"]` — it must run where the store lives (Remote-WSL, SSH).
- The mail store never lives inside a workspace folder, and the extension never puts a VS Code
  file watcher on mail data.
- TypeScript + esbuild, no native node modules. Platform-specific VSIX targets, never one fat
  multi-RID package.

## Entry gate

The engine has to be usable first. The daemon, CLI and MCP adapter are built and tested;
this client is the next milestone (SPEC §9, M3–M4).

## Licence

MIT — see the engine repository.
