import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

let pending = 0;

function describe(severity, message) {
  const at = message.location
    ? `${message.location.file}:${message.location.line}:${message.location.column}`
    : '<unknown>:0:0';
  return `${at}: ${severity}: ${message.text}`;
}

// One begin/end pair for both bundles: the background problem matcher toggles on each pair.
const reporter = {
  name: 'reporter',
  setup(build) {
    build.onStart(() => {
      if (pending++ === 0) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      for (const message of result.errors) {
        console.error(describe('error', message));
      }
      for (const message of result.warnings) {
        console.error(describe('warning', message));
      }
      if (--pending === 0) {
        console.log('[watch] build finished');
      }
    });
  },
};

// SPEC 6.3 forbids eval in the client: keep this free of inject shims and eval-based loaders.
const shared = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  plugins: [reporter],
};

const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
};

const webview = {
  ...shared,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  loader: { '.css': 'text' },
};

const configs = [extension, webview];

async function main() {
  // esbuild only overwrites what it emits, so a previous dev build's .map files would otherwise
  // survive into a production VSIX.
  if (production) {
    await rm(new URL('dist', import.meta.url), { recursive: true, force: true });
  }

  if (watch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  const results = await Promise.allSettled(configs.map((config) => esbuild.build(config)));
  for (const result of results) {
    if (result.status === 'rejected') {
      if (!Array.isArray(result.reason?.errors)) {
        console.error(result.reason);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
