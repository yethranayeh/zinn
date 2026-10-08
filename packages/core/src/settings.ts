import type { Settings } from "./schemas/settings";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { settingsSchema } from "./schemas/settings";
import { MAIN_FOLDER_NAME } from "./constant";

export const GLOBAL_SETTINGS_FILE_NAME = "settings.json";
export const LOCAL_SETTINGS_FILE_NAME = "zinn.local.json";
const GIT_ENTRY_NAME = ".git";

export type SettingsFile = {
  path: string;
  settings: Settings;
};

export type SettingsInputs = {
  /** The folder where the search for the per-codebase file starts. */
  cwd: string;
  /** Environment variables, such as `process.env`. */
  env: Record<string, string | undefined>;
  home: string;
};

export type ResolvedSettings = {
  /** The global file, or null when it does not exist. */
  global: SettingsFile | null;
  /** The nearest codebase file, or null when there is none. */
  local: SettingsFile | null;
  /** The local file merged over the global file. */
  merged: Omit<Settings, "$schema">;
};

/** An error that names the file and the problem. */
function settingsFileError(path: string, problem: string) {
  return new Error(`Cannot use settings file ${path}: ${problem}`);
}

/** Error codes for a file that does not exist: ENOTDIR when a folder on its path is a file. */
const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** Reads and validates one settings file. A file that does not exist gives `null` and any other problem throws. */
function readSettingsFile(path: string): SettingsFile | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const isMissingFile =
      error instanceof Error && "code" in error && MISSING_FILE_CODES.has(String(error.code));
    if (isMissingFile) {
      return null;
    }

    throw settingsFileError(
      path,
      `it cannot be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw settingsFileError(
      path,
      `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const result = settingsSchema.safeParse(parsed);
  if (!result.success) {
    throw settingsFileError(path, `it has invalid settings\n${z.prettifyError(result.error)}`);
  }

  return { path, settings: result.data };
}

/** The nearest folder at or above `directory` that holds a `.git` entry, a folder or a file, and `null` outside a repository. */
function findGitRoot(directory: string): string | null {
  let current = directory;

  while (true) {
    if (existsSync(join(current, GIT_ENTRY_NAME))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

/** The nearest `zinn.local.json` from `cwd` up to the Git root, inclusive. Outside a repository only `cwd` is checked. */
function readLocalSettings(cwd: string): SettingsFile | null {
  const start = resolve(cwd);
  const gitRoot = findGitRoot(start);
  let current = start;

  while (true) {
    const file = readSettingsFile(join(current, LOCAL_SETTINGS_FILE_NAME));
    if (file !== null) {
      return file;
    }

    const isLastFolderToCheck = gitRoot === null || current === gitRoot;
    if (isLastFolderToCheck) {
      return null;
    }

    current = dirname(current);
  }
}

/** Nested objects merge key by key, and fields the local file leaves out keep their global value. */
function mergeSettings(
  global: Settings | undefined,
  local: Settings | undefined,
): ResolvedSettings["merged"] {
  const storage =
    local?.storage === undefined ? global?.storage : { ...global?.storage, ...local.storage };

  return storage === undefined ? {} : { storage };
}

/**
 * Reads the global settings file and the nearest per-codebase file, and merges them.
 * It creates no file or folder. A file that exists but cannot be used throws.
 */
export function resolveSettings({ cwd, env, home }: SettingsInputs): ResolvedSettings {
  const globalDirectory = env.ZINN_DIR ?? join(home, MAIN_FOLDER_NAME);
  const global = readSettingsFile(join(globalDirectory, GLOBAL_SETTINGS_FILE_NAME));
  const local = readLocalSettings(cwd);

  return { global, local, merged: mergeSettings(global?.settings, local?.settings) };
}
