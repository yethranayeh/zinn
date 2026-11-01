import type { CliResult } from "./shared/cli";
import type { PresentedInfo } from "../../../packages/cli/src/result-schemas.js";

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createCliReader } from "./shared/cli";

export type Settings = {
  store: string;
  dataDirectory: string;
  cli: Array<string>;
  observe: boolean;
  identity: boolean;
  captureEffort: boolean;
};

export type SettingsOptions = Omit<Settings, "store"> & { store?: string };

function canonicalPath(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }

  return join(canonicalPath(dirname(path)), basename(path));
}

function selectStore(options: SettingsOptions, path: string): Settings {
  const store = canonicalPath(resolve(path));
  const data = options.dataDirectory;

  if (data === store || data.startsWith(store + sep)) {
    throw new Error("dataDirectory must be outside the selected Zinn data directory.");
  }

  return { ...options, store };
}

export function loadSettings(env = process.env, home = homedir()): SettingsOptions {
  const configPath = env.ZINN_CODEX_CONFIG ?? join(home, ".config/zinn/codex.json");
  if (!isAbsolute(configPath)) {
    throw new Error("ZINN_CODEX_CONFIG must be an absolute path.");
  }

  let value;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const missingDefault =
      env.ZINN_CODEX_CONFIG === undefined && (error as NodeJS.ErrnoException).code === "ENOENT";

    if (!missingDefault) {
      throw error;
    }

    value = {};
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("codex.json must contain an options object.");
  }

  if (value.store !== undefined && (typeof value.store !== "string" || !isAbsolute(value.store))) {
    throw new Error("Set store to an absolute Zinn data directory in codex.json.");
  }

  const dataDirectory = value.dataDirectory ?? join(home, ".local/share/zinn-codex");
  if (typeof dataDirectory !== "string" || !isAbsolute(dataDirectory)) {
    throw new Error("dataDirectory must be an absolute path.");
  }

  const data = canonicalPath(resolve(dataDirectory));

  const cli = value.cli ?? ["zinn"];
  if (
    !Array.isArray(cli) ||
    cli.length === 0 ||
    cli.some((word) => typeof word !== "string" || word === "")
  ) {
    throw new Error("cli must be a nonempty array of executable and argument strings.");
  }

  for (const option of ["observe", "identity", "captureEffort"]) {
    if (value[option] !== undefined && typeof value[option] !== "boolean") {
      throw new Error(`${option} must be a boolean.`);
    }
  }

  const options: SettingsOptions = {
    store: value.store,
    dataDirectory: data,
    cli,
    observe: value.observe ?? true,
    identity: value.identity ?? true,
    captureEffort: value.captureEffort ?? false,
  };
  return options.store === undefined ? options : selectStore(options, options.store);
}

export async function resolveSettings(
  options: SettingsOptions,
  {
    deadline,
    signal,
    cwd = homedir(),
  }: { deadline?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<{ settings: Settings; info?: CliResult<PresentedInfo> }> {
  if (options.store !== undefined) {
    return { settings: selectStore(options, options.store) };
  }

  const reader = createCliReader(options, { deadline, cwd });
  try {
    const info = await reader.run<PresentedInfo>(["info"], signal);
    signal?.throwIfAborted();
    if (!info.ok) {
      throw new Error(info.error);
    }

    const storage = info.value?.storage;

    if (
      typeof storage?.directory !== "string" ||
      storage.directory === "" ||
      storage.error !== null
    ) {
      throw new Error(storage?.error ?? "Could not resolve the Zinn data directory.");
    }

    return { settings: selectStore(options, resolve(cwd, storage.directory)), info };
  } finally {
    await reader.close();
  }
}
