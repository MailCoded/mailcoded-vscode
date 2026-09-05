# mailcoded-vscode

Read, search, and triage your mail inside VS Code. A client for the
[mailcoded](https://github.com/MailCoded/mailcoded) engine.

**Status: scaffold.** The build, the lint and invariant checks, the typecheck, and the packaging
step all work. The extension itself does nothing yet: it activates, opens an output channel, and
stops. It cannot read a message. Nothing here is published anywhere.

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
- Exactly two runtime dependencies: `vscode-jsonrpc` and `dompurify`. Everything else is a
  devDependency and does not ship. `npm run license-check` fails the build if that stops being
  true.

The full set, with provenance, is in [CLAUDE.md](CLAUDE.md).

## Building it from source

There is no VSIX to download and there will not be one until the client does something. To build
what exists:

```bash
git clone https://github.com/MailCoded/mailcoded-vscode
cd mailcoded-vscode
npm ci
npm run build
```

Requires Node 22. `npm run build` produces `dist/extension.js` and `dist/webview/main.js`; nothing
else is generated and nothing is installed globally.

Then open the folder in VS Code and press **F5** (the *Run Extension* configuration). That starts
`npm run watch` as a pre-launch task and opens an Extension Development Host with the extension
loaded. Reload the host window to pick up a rebuild.

The extension does not ship a daemon and it will not download one. It expects `MAILCODED_DAEMON`
to name a `mailcoded-daemon` executable — the same variable the engine's terminal client uses.
`.vscode/launch.json` already sets it to the sibling checkout's Debug build:

```
../mailcoded/src/Mailcoded.Daemon/bin/Debug/net10.0/mailcoded-daemon
```

so `git clone` the two repositories next to each other, run the engine's `scripts/build.sh`, and
F5 finds it. If your engine lives somewhere else, or you installed it with the engine's
`scripts/install.sh`, override the variable in your environment before launching VS Code:

```bash
export MAILCODED_DAEMON="$HOME/.local/libexec/mailcoded/mailcoded-daemon"
```

The engine's
[installation chapter](https://github.com/MailCoded/mailcoded/blob/main/docs/manual/01-install.md)
covers building the daemon. Note that the AOT binaries load `libe_sqlite3.so` from their own
directory and will not start without it, so point at a binary that still sits beside its library.

Everything CI runs, you can run:

```bash
npm run lint
npm run lint:invariants   # the security rules ESLint cannot express
npm run typecheck         # three tsconfigs: host, webview, tests
npm run license-check
npm run build:production
npm run package           # a local VSIX; this publishes nothing
```

## Editor configuration

The mail store must **never** live inside a workspace folder, and no editor should watch or index
it. If a store directory is ever visible to your editor, exclude it — a 500k-message SQLite
database plus a WAL will otherwise be re-indexed on every write.

```jsonc
{
  "files.watcherExclude": {
    "**/mailcoded/**": true,
    "**/*.db": true,
    "**/*.db-wal": true,
    "**/*.db-shm": true
  },
  "search.exclude": {
    "**/mailcoded/**": true,
    "**/*.db": true,
    "**/*.db-wal": true,
    "**/*.db-shm": true
  }
}
```

Default store roots: `%LOCALAPPDATA%\mailcoded` on Windows,
`~/Library/Application Support/mailcoded` on macOS, `$XDG_DATA_HOME/mailcoded` (usually
`~/.local/share/mailcoded`) on Linux.

## What does not work yet

Stated plainly, because the status line above is easy to skim past. As of this commit there is:

- **No daemon process management.** Nothing spawns `mailcoded-daemon`, so `MAILCODED_DAEMON` is
  read by nothing yet. The variable is documented above because it is the contract the client will
  use, not because setting it does anything today.
- **No JSON-RPC client.** No connection, no `initialize`, no method call.
- **No UI at all** — no sidebar, no message list, no reader webview, no compose buffer, no status
  bar item, no onboarding flow, no commands worth invoking. `activate()` opens an output channel
  named *Mailcoded Daemon* and returns.
- **No tests.** The `test:unit`, `test:sanitize` and `test:e2e` scripts are declared, and the CI
  job that would run them deliberately does not exist yet, because a workflow calling a harness
  that has not landed is just a red build.
- No account setup, no sync, no search, no send, no attachments, no tags.

The protocol types are vendored from the engine and checked in; `npm run sync:protocol` refreshes
them. The `protocol-drift` CI job is advisory by design — the engine's default branch moves
independently of the copy pinned here.

## Entry gate

The engine had to be usable first, and now is: the daemon, CLI, TUI and MCP adapter build, and the
JSON-RPC surface is documented in
[docs/rpc.md](https://github.com/MailCoded/mailcoded/blob/main/docs/rpc.md). This client is the
current milestone (SPEC §9, M3–M4), and this repository is where it gets built.

## Licence

MIT — see [LICENSE](LICENSE). Third-party notices, including the DOMPurify licence election, are
in [NOTICE](NOTICE).
