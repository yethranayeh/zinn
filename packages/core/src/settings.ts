import type { Settings, TelemetryMode } from "./schemas/settings.js";
import type { FailureFacts, FailureKind } from "./errors.js";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { settingsSchema } from "./schemas/settings.js";
import { MAIN_FOLDER_NAME } from "./constant.js";
import { CoreError, errorMessage, InputValidationError, isMissingFileError } from "./errors.js";

export const GLOBAL_SETTINGS_FILE_NAME = "settings.json";
export const LOCAL_SETTINGS_FILE_NAME = "zinn.local.json";
const GIT_ENTRY_NAME = ".git";

/** One megabyte, as `telemetry.maxMegabytes` counts it. */
export const BYTES_PER_MEGABYTE = 1_048_576;
export const DEFAULT_TELEMETRY_MODE: TelemetryMode = "local";
export const DEFAULT_TELEMETRY_MAX_MEGABYTES = 100;
export const DEFAULT_TELEMETRY_MAX_AGE_DAYS = 90;
const DO_NOT_TRACK_VARIABLE = "DO_NOT_TRACK";

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
  /** The nearest codebase file, or `null` when absent or `ZINN_DIR` selects the settings. */
  local: SettingsFile | null;
  /** The local file merged over the global file. */
  merged: Omit<Settings, "$schema" | "hooks">;
};

/** Where the telemetry mode came from */
export const telemetrySourceSchema = z.enum(["default", "DO_NOT_TRACK", "settings"]);
export type TelemetrySource = z.infer<typeof telemetrySourceSchema>;

export type ResolvedTelemetry = {
  mode: TelemetryMode;
  source: TelemetrySource;
  /** The settings file whose `telemetry.mode` chose the mode, or `null` when the default or `DO_NOT_TRACK` did. */
  settingsPath: string | null;
  maxMegabytes: number;
  maxAgeDays: number;
};

export const settingsFileSourceSchema = z.enum(["env", "global", "local"]);
export const settingsFileStateSchema = z.enum(["found", "missing", "error", "not-read"]);

export type SettingsFileInspection = {
  path: string;
  source: z.infer<typeof settingsFileSourceSchema>;
} & (
  | { state: typeof settingsFileStateSchema.enum.found; settings: Settings }
  | { state: typeof settingsFileStateSchema.enum.missing }
  | { state: typeof settingsFileStateSchema.enum.error; error: string }
  | { state: (typeof settingsFileStateSchema.enum)["not-read"]; reason: "ZINN_DIR" }
);

export type SettingsInspection = Pick<ResolvedSettings, "global" | "local"> & {
  files: Array<SettingsFileInspection>;
};

/** An error that names the file and the problem. */
function settingsFileError(
  path: string,
  problem: string,
  kind: FailureKind,
  facts: FailureFacts,
  cause: unknown,
) {
  return new CoreError(
    `Cannot use settings file ${path}: ${problem}`,
    kind,
    { ...facts, settingsPath: path },
    { cause },
  );
}

/** Reads and validates one settings file. A file that does not exist gives `null` and any other problem throws. */
function readSettingsFile(path: string): SettingsFile | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw settingsFileError(
      path,
      `it cannot be read (${errorMessage(error)})`,
      "storage",
      {},
      error,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw settingsFileError(
      path,
      `it is not valid JSON (${errorMessage(error)})`,
      "input",
      { reason: "invalid_json" },
      error,
    );
  }

  const result = settingsSchema.safeParse(parsed);
  if (!result.success) {
    const validation = new InputValidationError(result.error.issues);

    throw settingsFileError(
      path,
      `it has invalid settings\n${z.prettifyError(result.error)}`,
      "input",
      { reason: "invalid_settings", field: validation.facts.field },
      result.error,
    );
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
function readLocalSettings(
  cwd: string,
  readFile: (path: string) => SettingsFileInspection,
): SettingsFileInspection | null {
  const start = resolve(cwd);
  const gitRoot = findGitRoot(start);
  let current = start;

  while (true) {
    const file = readFile(join(current, LOCAL_SETTINGS_FILE_NAME));
    if (file.state !== "missing") {
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
  const telemetry =
    local?.telemetry === undefined
      ? global?.telemetry
      : { ...global?.telemetry, ...local.telemetry };
  const defaultProject = local?.defaultProject ?? global?.defaultProject;

  return {
    ...(storage === undefined ? {} : { storage }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(defaultProject === undefined ? {} : { defaultProject }),
  };
}

/** The defaultProject key, decided by local first, global after, or `null` */
export function chooseDefaultProject({
  local,
  global,
}: Pick<ResolvedSettings, "global" | "local">): { key: string; settingsPath: string } | null {
  for (const file of [local, global]) {
    const key = file?.settings.defaultProject;

    if (file !== null && key !== undefined) {
      return { key, settingsPath: file.path };
    }
  }

  return null;
}

/**
 * Whether the `DO_NOT_TRACK` variable asks for no tracking.
 * Following https://donottrack.sh/, only the value `1` counts.
 */
function isDoNotTrackSet(env: SettingsInputs["env"]) {
  return env[DO_NOT_TRACK_VARIABLE] === "1";
}

/** A `telemetry` field decided by the codebase file first, the global file after, or `null` when neither sets it. */
function chooseTelemetryField<Field extends "mode" | "maxMegabytes" | "maxAgeDays">(
  { local, global }: Pick<ResolvedSettings, "global" | "local">,
  field: Field,
): { value: NonNullable<NonNullable<Settings["telemetry"]>[Field]>; settingsPath: string } | null {
  for (const file of [local, global]) {
    const value = file?.settings.telemetry?.[field];

    if (file !== null && value !== undefined) {
      return { value, settingsPath: file.path };
    }
  }

  return null;
}

/**
 * The telemetry mode and its limits.
 * The mode is the nearest `telemetry.mode` in a settings file (the codebase file before the global one),
 *  else off when `DO_NOT_TRACK` is 1, else local.
 * A settings file overrides `DO_NOT_TRACK`.
 * The limits come from the same files, else their defaults.
 */
export function resolveTelemetry(
  { local, global }: Pick<ResolvedSettings, "global" | "local">,
  env: SettingsInputs["env"],
): ResolvedTelemetry {
  const modeChoice = chooseTelemetryField({ local, global }, "mode");
  const maxMegabytes =
    chooseTelemetryField({ local, global }, "maxMegabytes")?.value ??
    DEFAULT_TELEMETRY_MAX_MEGABYTES;
  const maxAgeDays =
    chooseTelemetryField({ local, global }, "maxAgeDays")?.value ?? DEFAULT_TELEMETRY_MAX_AGE_DAYS;

  if (modeChoice !== null) {
    return {
      mode: modeChoice.value,
      source: "settings",
      settingsPath: modeChoice.settingsPath,
      maxMegabytes,
      maxAgeDays,
    };
  }

  if (isDoNotTrackSet(env)) {
    return { mode: "off", source: "DO_NOT_TRACK", settingsPath: null, maxMegabytes, maxAgeDays };
  }

  return {
    mode: DEFAULT_TELEMETRY_MODE,
    source: "default",
    settingsPath: null,
    maxMegabytes,
    maxAgeDays,
  };
}

/**
 * Reads the global settings file and the nearest per-codebase file, and merges them.
 * With `ZINN_DIR`, only that directory's **settings.json** is read.
 * It does not create any file or folder just to be able to resolve it.
 * An unusable file throws.
 */
export function resolveSettings(inputs: SettingsInputs): ResolvedSettings {
  const { global, local } = loadSettings(inputs, { collectErrors: false });
  return { global, local, merged: mergeSettings(global?.settings, local?.settings) };
}

/** Reports settings files and their errors without creating files or folders. */
export function inspectSettings(inputs: SettingsInputs): SettingsInspection {
  return loadSettings(inputs, { collectErrors: true });
}

function loadSettings(
  { cwd, env, home }: SettingsInputs,
  { collectErrors }: { collectErrors: boolean },
): SettingsInspection {
  const files: Array<SettingsFileInspection> = [];
  const readFile = (
    path: string,
    source: SettingsFileInspection["source"],
  ): SettingsFileInspection => {
    let inspected: SettingsFileInspection;
    try {
      const file = readSettingsFile(path);
      if (source === "local" && file?.settings.hooks !== undefined) {
        throw settingsFileError(
          path,
          `it sets hooks, which Zinn reads only from the global ${GLOBAL_SETTINGS_FILE_NAME}`,
          "input",
          { reason: "invalid_settings", field: ["hooks"] },
          undefined,
        );
      }
      inspected =
        file === null
          ? { path, source, state: "missing" }
          : { path, source, state: "found", settings: file.settings };
    } catch (error) {
      if (!collectErrors) {
        throw error;
      }

      inspected = { path, source, state: "error", error: errorMessage(error) };
    }
    files.push(inspected);
    return inspected;
  };
  const globalDirectory = env.ZINN_DIR ?? join(home, MAIN_FOLDER_NAME);
  const selected = readFile(
    join(globalDirectory, GLOBAL_SETTINGS_FILE_NAME),
    env.ZINN_DIR === undefined ? "global" : "env",
  );
  const nearest =
    env.ZINN_DIR === undefined ? readLocalSettings(cwd, (path) => readFile(path, "local")) : null;
  const global =
    selected.state === "found" ? { path: selected.path, settings: selected.settings } : null;
  const local =
    nearest?.state === "found" ? { path: nearest.path, settings: nearest.settings } : null;

  if (collectErrors && env.ZINN_DIR !== undefined) {
    const homeSettings = join(home, MAIN_FOLDER_NAME, GLOBAL_SETTINGS_FILE_NAME);
    if (resolve(homeSettings) !== resolve(selected.path)) {
      files.push({ path: homeSettings, source: "global", state: "not-read", reason: "ZINN_DIR" });
    }

    files.push({
      path: join(resolve(cwd), LOCAL_SETTINGS_FILE_NAME),
      source: "local",
      state: "not-read",
      reason: "ZINN_DIR",
    });
  }

  return { global, local, files };
}
