import type { ResolvedSettings, SettingsInputs } from "./settings";

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { resolveSettings } from "./settings";

export const MAIN_FOLDER_NAME = ".zinn";
export const DB_FILE_NAME = "zinn.sqlite";
/** A storage.directory of `~`, or starting with `~/`, starts at the home directory. */
const HOME_SHORTHAND = "~";
const HOME_SHORTHAND_PREFIX = "~/";

/**
 * Where the store's folder came from: `ZINN_DIR`, storage.directory in the per-codebase or the global
 *  settings file, or the default folder in the home directory.
 */
export type StorageSource = "env" | "local" | "global" | "default";

type StoragePaths = {
  /** The store's folder. */
  directory: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
};

export type Storage = StoragePaths & {
  source: StorageSource;
  /** The default folder in the home directory, which a folder from another source may also reach. */
  defaultDirectory: string;
};

type StorageInputs = SettingsInputs;

/** A store's folder chosen by storage.directory, and the settings file that chose it. */
type SettingsChoice = {
  source: "local" | "global";
  directory: string;
  settingsPath: string;
};

/** The paths inside a store's folder. */
function storagePaths(directory: string): StoragePaths {
  const dataDirectory = join(directory, "data");

  return {
    directory,
    dataDirectory,
    databasePath: join(dataDirectory, DB_FILE_NAME),
    backupDirectory: join(directory, "backups"),
  };
}

/** Replaces a leading `~` or `~/` with the home directory. Any other value, such as `~user`, stays as written. */
function expandHome(directory: string, home: string) {
  if (directory === HOME_SHORTHAND) {
    return home;
  }

  if (directory.startsWith(HOME_SHORTHAND_PREFIX)) {
    return join(home, directory.slice(HOME_SHORTHAND_PREFIX.length));
  }

  return directory;
}

/**
 * The folder storage.directory chooses, from the per-codebase file before the global one, or null when neither sets it.
 * A relative folder resolves against the folder of the file that sets it.
 */
function chooseFromSettings(
  { local, global }: ResolvedSettings,
  home: string,
): SettingsChoice | null {
  const candidates = [
    { source: "local", file: local },
    { source: "global", file: global },
  ] as const;

  for (const { source, file } of candidates) {
    const directory = file?.settings.storage?.directory;

    if (file !== null && directory !== undefined) {
      return {
        source,
        directory: resolve(dirname(file.path), expandHome(directory, home)),
        settingsPath: file.path,
      };
    }
  }

  return null;
}

/**
 * A test run (`NODE_ENV="test"`) refuses a store outside the temporary directory unless `ZINN_DIR` chose it,
 *  so a test that misses `ZINN_DIR` fails instead of using a real database.
 */
function refuseOutsideTemporaryInTestRun(
  directory: string,
  env: StorageInputs["env"],
  settingsPath: string | null,
) {
  if (env.NODE_ENV !== "test") {
    return;
  }

  const temporaryDirectory = tmpdir();
  // A folder found from process.cwd() has its real path, which can differ from tmpdir(), as /private/var does from /var on macOS.
  const temporaryPaths = [temporaryDirectory, realpathSync(temporaryDirectory)];
  const isInsideTemporary = temporaryPaths.some((temporaryPath) => {
    const pathFromTemporary = relative(temporaryPath, directory);
    return !pathFromTemporary.startsWith("..") && !isAbsolute(pathFromTemporary);
  });

  if (isInsideTemporary) {
    return;
  }

  if (settingsPath === null) {
    throw new Error(
      `Refusing to use ${directory} in a test run (NODE_ENV=test): a test's Zinn folder must be inside ${temporaryDirectory}. Set ZINN_DIR, or HOME, to a temporary folder`,
    );
  }

  throw new Error(
    `Refusing to use ${directory}, chosen by the settings file ${settingsPath}, in a test run (NODE_ENV=test): a test's Zinn folder must be inside ${temporaryDirectory}. Set ZINN_DIR to a temporary folder`,
  );
}

/**
 * Finds the store's folder from the given inputs: `ZINN_DIR`, then storage.directory in the per-codebase
 *  settings file, then in the global one, then the default folder.
 * The selected settings files are validated before the store is resolved.
 */
export function resolveStorage(inputs: StorageInputs): Storage {
  const { env, home } = inputs;
  const defaultDirectory = join(home, MAIN_FOLDER_NAME);
  const settings = resolveSettings(inputs);

  if (env.ZINN_DIR !== undefined) {
    return { ...storagePaths(env.ZINN_DIR), source: "env", defaultDirectory };
  }

  const choice = chooseFromSettings(settings, home);
  if (choice !== null) {
    refuseOutsideTemporaryInTestRun(choice.directory, env, choice.settingsPath);
    return { ...storagePaths(choice.directory), source: choice.source, defaultDirectory };
  }

  refuseOutsideTemporaryInTestRun(defaultDirectory, env, null);
  return { ...storagePaths(defaultDirectory), source: "default", defaultDirectory };
}

let processStorage: Storage | null = null;

/** This process's store, resolved from its working folder, environment and home directory on first use, then kept. */
export function getStorage() {
  if (processStorage === null) {
    processStorage = resolveStorage({ cwd: process.cwd(), env: process.env, home: homedir() });
  }

  return processStorage;
}

export const DB_TABLE = {
  project: "project",
  projectColumn: "project_column",
  task: "task",
  task_relations: "task_relations",
  label: "label",
  taskLabel: "task_label",
  comment: "comment",
  taskSearch: "task_search",
  activity: "activity",
};
