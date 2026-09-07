# CLAUDE.md — mailcoded-vscode

Rules for anyone working in this repository, human or AI.

This is the **client**. The engine lives in a sibling checkout,
[`MailCoded/mailcoded`](https://github.com/MailCoded/mailcoded), and it is normative. Read the
engine's `SPEC.md` §6 (the extension specification; §6.1 is `[DECIDED]`) and its `CLAUDE.md`
before changing anything here. Nothing in this file invents a new rule — every invariant below is
carried over, with its source named, so that you do not have to open two repositories to know what
is forbidden. **Where this file and the engine's SPEC conflict, the engine's `CLAUDE.md` wins**,
and say so in your summary.

## What this is

A thin JSON-RPC client for the `mailcoded-daemon`, packaged as a VS Code extension. It spawns the
daemon as a child process and speaks Content-Length-framed JSON-RPC 2.0 over stdio, the way a
language client talks to a language server. It holds no mail logic. Every safety gate lives in
`Mailcoded.Core`, never in a client — engine `SPEC.md` §7.

## Commands

```bash
npm ci                    # never `npm install` in CI or in a review
npm run build             # esbuild -> dist/extension.js and dist/webview/main.js
npm run watch             # rebuild on change; use with F5
npm run typecheck         # all three tsconfigs
npm run lint
npm run lint:invariants   # the rules below that ESLint cannot express
npm run license-check     # fails if the shipped dependency set changes
npm run test:unit
npm run test:sanitize     # jsdom; the DOMPurify and CSP tests
npm run test:e2e          # downloads a VS Code build and drives it
npm run smoke:webview     # drives the built webview bundle in a local headless Chromium under the real CSP
npm run package           # vsce package --no-dependencies -- builds a VSIX, publishes nothing
npm run sync:protocol     # vendor the engine's generated protocol types
```

## Hard invariants — never violate, never "temporarily" disable

1. **This extension never opens a network connection to a mail server.** Not IMAP, not SMTP, not
   Graph, not an HTTP fetch of a remote image. Only the daemon talks to a server. If a feature
   seems to need a socket here, it belongs in the engine. *(engine `CLAUDE.md` #6, `SPEC.md` §6.1)*

2. **Mail content is untrusted attacker input.** Subjects, headers, addresses, bodies, filenames,
   every one of them. Never pass mail content into a shell command, a terminal, a task, `eval`,
   a `file://` path, a URI you construct, or a `child_process` argument. Never render `bodyHtml`
   anywhere but the sandboxed webview. *(engine `CLAUDE.md` #4)*

3. **HTML mail renders only inside the webview, only after DOMPurify, only under the CSP in
   `SPEC.md` §6.3.** That CSP is exactly:

   ```
   default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-<nonce>'; img-src data:;
   ```

   **No remote origin, ever** — not a CDN, not a font host, not an image proxy. Sanitize *inside*
   the webview, not in the extension host, with `FORBID_TAGS: ['script','iframe','object','embed','form','link','meta','base']`,
   every `on*` in `FORBID_ATTR`, and a URL scheme allowlist of `https` and `mailto`. Remote images
   are blocked and surfaced as a "N remote images blocked" bar; an explicit per-message allow swaps
   `img-src` for that one render and nothing else. Links open through `vscode.env.openExternal`
   only. Any change to sanitization or CSP is security-sensitive: add a test in `test/sanitize`
   and flag it in the PR description for human review. *(engine `SPEC.md` §6.3, `CLAUDE.md` #4)*

4. **Never log request params or responses.** They carry credentials (`secret.set`) and the
   one-time tokens from `send.preview`. Log method names, error codes, and durations — nothing
   else. `vscode-jsonrpc` tracing stays off: `connection.trace(...)` is never called with anything
   but `Trace.Off`, and no `Tracer` is wired to the output channel — not even behind a setting.
   *(engine `CLAUDE.md` #3, `SPEC.md` §5.7)*

5. **There is no delete.** No delete, expunge, trash, or purge — not in this client, not in the
   protocol, not behind a confirmation, not behind a setting. Absent, not gated. Do not add one,
   and do not add a command whose effect is one. *(engine `CLAUDE.md` #5, `README.md`)*

6. **No VS Code file watchers on mail data**, and no `workspace.findFiles` or `FileSystemWatcher`
   pointed anywhere near the store. Change signals arrive as daemon notifications
   (`notify.mail.added`, `notify.folder.updated`, `notify.sync.error`) and only as those. The mail
   store never lives inside a workspace folder, and nothing here may put it there or suggest a
   user do so. *(engine `CLAUDE.md` #6, `SPEC.md` §6.4)*

7. **Always pass a `limit` to `search`, and page with `nextCursor`.** Page size is 50. Never issue
   an unbounded `search`, never build a client-side "load everything" path, never fetch a body you
   are not about to show. *(engine `SPEC.md` §6.4)*

8. **Two runtime dependencies, and they are `vscode-jsonrpc` (MIT) and `dompurify`
   (MPL-2.0 OR Apache-2.0; this project elects Apache-2.0).** Everything else is a devDependency.
   No native node modules — the extension must load under Remote-WSL and Remote-SSH on every
   platform. A third runtime dependency needs the same vetting rule as the engine's
   `docs/DEPENDENCIES.md`: permissive licence (MIT / Apache-2.0 / BSD-2/3), maintained within
   twelve months, and a measured size delta. `npm run license-check` enforces the set; do not
   weaken it to make a change pass.

9. **`"extensionKind": ["workspace"]`.** It must run where the store lives. Untrusted-workspace
   support is *limited*: reading works, sending does not. *(engine `SPEC.md` §6.1)*

10. **The display name must not imply Microsoft affiliation** and must not contain "VS Code".
    It is "Mailcoded". *(engine `SPEC.md` §6.1)*

## Protocol types

The wire types are **generated from the C# DTOs** in `Mailcoded.Protocol` by
`tools/Mailcoded.Protocol.TypeScript` in the engine repo, and land there as
`packages/protocol/src/generated.ts`. This repository vendors a copy rather than depending on an
unpublished package.

```bash
npm run sync:protocol                              # refresh from the sibling checkout
MAILCODED_ENGINE_DIR=../mailcoded npm run sync:protocol
npm run sync:protocol -- --check                   # fail if the vendored copy has drifted
```

Never hand-edit the vendored file, and never add a field to it to make something compile — a DTO
change is an engine PR first, then a regeneration here. The `protocol-drift` CI job runs `--check`
and is deliberately advisory: the engine's default branch moves independently of the copy pinned
here, so a red mark there means "regenerate", not "this commit is broken".

## Conventions

- TypeScript is pinned to `^5.9.0` on purpose. 7.x is the native port; it is not worth early
  adoption on a security-sensitive client. Dependabot is configured not to offer it.
- `@types/vscode` must never exceed the `engines.vscode` floor (`^1.96.0`), or the extension will
  compile against API that its declared minimum host does not have.
- The extension host bundle targets node22; the webview bundle targets es2022 for a browser. The
  host tsconfig has **no** DOM lib and the webview tsconfig has no node types. Do not "simplify"
  them into one — the separation is what stops `document` from being reachable in the host and
  `child_process` from being reachable in the webview.
- Errors from the daemon carry stable numeric codes (engine `SPEC.md` §5.6): `1000` auth,
  `1001` network, `1002` not-found, `1003` confirm-required, `1004` store-corrupt,
  `1005` rate-limited. Switch on the code, never on the message text.
- Vocabulary is normative and shared with the engine: Account, Folder, Envelope, Message, Blob,
  **Tag** (local) vs **Flag** (server IMAP). No synonyms — never "label" for Tag, never "mailbox"
  for Folder. *(engine `CLAUDE.md` #14)*
- Commits are conventional: `feat:`, `fix:`, `test:`, `perf:`, `chore:`.

## Comment policy

No comments by default. Add one only when the reason is non-obvious: a hidden constraint, a subtle
invariant, a workaround. Never explain what the code does. Never mention tickets, bugs, prior
versions, or an AI. One line, three at the absolute maximum, and never more than three consecutive
comment lines anywhere. If unsure, omit it.

## Definition of done

- `npm run lint`, `lint:invariants`, `typecheck`, `license-check`, and `build:production` all pass.
- New behaviour has a test. Anything touching sanitization or CSP has a test in `test/sanitize`
  and is flagged for human review.
- No invariant above weakened, and no invariant check disabled to make CI green.
- The SPEC section the change satisfies is named in the PR description.

## Things Claude must NOT do

- **Publish.** Not to the Visual Studio Marketplace, not to Open VSX, not anywhere. No `vsce
  publish`, no `ovsx`, no publish workflow, no marketplace token in a secret, a workflow, or a
  file. `npm run package` builds a VSIX locally and that is the end of it; a human publishes.
- **Tag a release**, bump a version toward one, or write release notes as though one had happened.
- **Create a git commit inside working hours, 09:30–18:30 NZST, on any day.** Stage the work and
  leave it, or commit outside that window.
- Add telemetry, analytics, error reporting, or any network call whatsoever. This extension makes
  none. *(engine `CLAUDE.md`)*
- Add an auto-updater.
- Send real email, or put real credentials anywhere. Test against the engine's fixtures.
- Modify the engine checkout from here.
