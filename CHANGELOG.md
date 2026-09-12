# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is released. There is no tag, no VSIX on any marketplace, and no version
of this extension that reads mail. What exists is a scaffold that builds.

### Added

- **Search by meaning, where the daemon offers it.** `search` now carries the engine's `semantic`
  parameter and surfaces the `relaxed` and `semantic` flags it answers with. A new command,
  *Search Mail by Meaning...*, asks for it explicitly; a new setting, `mailcoded.searchMode`
  (`auto` | `words`), decides what an ordinary search does. `auto` leaves the choice to the daemon,
  which fuses meaning in only when a model is installed.
  - The message list explains itself rather than silently reordering: *"Ranked by meaning as well
    as words"* when fusion happened, and *"Nothing matched every word"* when the daemon widened a
    query. A fused page carries no cursor by design, so no **Load More** row is offered and the
    absence is not reported as dropped matches.
  - Asking for meaning from a daemon with no model is refused in the client with `1008` rather than
    sent, and the command says so before opening an input box. The command and its toolbar button
    are hidden unless `capabilities.semantic` is true.
  - **The engine ships no model**, so on a default install this changes nothing, and whether the
    ranking is an improvement is unmeasured upstream.
- **Build pipeline.** TypeScript compiled by esbuild into two bundles:
  `src/extension.ts` → `dist/extension.js` (node22, CJS, `vscode` external) and
  `src/webview/main.ts` → `dist/webview/main.js` (browser, IIFE), with
  `src/webview/styles.css` inlined into the webview bundle. `npm run build`,
  `build:production`, and `watch` drive all of it.
- **Three tsconfigs**, because the extension host and the webview are different
  runtimes and must not share a `lib`: `tsconfig.json` (es2022, node + vscode
  types, **no** DOM), `tsconfig.webview.json` (es2022 + DOM, no ambient types),
  and `tsconfig.test.json`. `npm run typecheck` runs all three.
- **Placeholder entry points** so the build and typecheck are green from the
  first commit: `activate()` creates an output channel named *Mailcoded Daemon*;
  the webview installs a `securitypolicyviolation` listener and posts
  `{type:'ready'}`. No daemon logic yet.
- **Extension manifest** with `"extensionKind": ["workspace"]` and limited
  untrusted-workspace support — reading works, sending does not.
- **`npm run lint:invariants`**, a repo-specific check for the security rules in
  CLAUDE.md that ESLint cannot express.
- **`npm run license-check`**, which fails if the shipped dependency set is ever
  anything other than `vscode-jsonrpc` and `dompurify`.
- **`npm run sync:protocol`**, which vendors the TypeScript types the engine
  generates from its C# DTOs, and `--check` to detect drift.
- **CI** (`check`): lint, invariants, typecheck, licences, production build, and
  `vsce package --no-dependencies` uploaded as an artifact. A second job,
  `protocol-drift`, is advisory. There is no publish job and no marketplace
  token anywhere in this repository.
- **Dependabot** for npm and GitHub Actions, with TypeScript held on 5.x and
  `@types/vscode` held at the `engines.vscode` floor.
- MIT `LICENSE`, `NOTICE` recording the DOMPurify licence election, and
  `CLAUDE.md` carrying the engine's invariants into this repo.

### Not yet present

No daemon process management, no JSON-RPC client, no tree views, no reader
webview, no compose, no onboarding, no tests. Those land in later phases.
