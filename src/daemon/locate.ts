import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import type { DaemonLocation, DaemonLocationSource } from "./types.js";
import { DAEMON_EXECUTABLE_ENV_VAR, DAEMON_EXECUTABLE_NAME } from "./types.js";

export interface LocateDaemonOptions {
  /** `mailcoded.daemonPath`; honoured only when the workspace is trusted. */
  readonly settingPath?: string | undefined;
  readonly isTrusted?: boolean | undefined;
  readonly extensionPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
}

export function daemonExecutableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? [`${DAEMON_EXECUTABLE_NAME}.exe`, DAEMON_EXECUTABLE_NAME]
    : [DAEMON_EXECUTABLE_NAME];
}

export function bundledDaemonDirectory(
  extensionPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  return path.join(extensionPath, "bin", `${platform}-${arch}`);
}

export function findDaemonOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const names = daemonExecutableNames(platform);
  for (const entry of pathEntries(env)) {
    for (const name of names) {
      const candidate = path.resolve(entry, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function findBundledDaemon(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const directory = bundledDaemonDirectory(extensionPath, platform, arch);
  for (const name of daemonExecutableNames(platform)) {
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

/** Setting, env, bundled, PATH — first hit wins. An explicit setting or env value is taken verbatim
 * and never falls through, so a typo fails naming that path instead of silently running another. */
export function locateDaemon(options: LocateDaemonOptions = {}): DaemonLocation | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;

  if (options.isTrusted === true) {
    const configured = blankToUndefined(options.settingPath);
    if (configured !== undefined) return at(configured, "setting");
  }

  const fromEnv = blankToUndefined(env[DAEMON_EXECUTABLE_ENV_VAR]);
  if (fromEnv !== undefined) return at(fromEnv, "env");

  if (options.extensionPath !== undefined && options.extensionPath !== "") {
    const bundled = findBundledDaemon(options.extensionPath, platform, arch);
    if (bundled !== undefined) return at(bundled, "bundled");
  }

  const onPath = findDaemonOnPath(env, platform);
  if (onPath !== undefined) return at(onPath, "path");

  return undefined;
}

function at(file: string, source: DaemonLocationSource): DaemonLocation {
  return { file, source };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function pathEntries(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env["PATH"] ?? env["Path"] ?? env["path"];
  if (raw === undefined || raw === "") return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

/** Existence and the execute bit only: probing by running it would cost a spawn on every start. */
function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
