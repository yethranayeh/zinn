import type { ResolvedSettings, SettingsInputs } from "./settings.js";

import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { resolveDatabasePath, type ResolvedPath } from "./database-path.js";
import { resolveSettings } from "./settings.js";
import { CoreError, isMissingFileError } from "./errors.js";
import { DB_FILE_NAME, MAIN_FOLDER_NAME } from "./constant.js";

/** If `storage.directory` has `~`, or starts with `~/`, it is interpreted as home directory. */
const HOME_SHORTHAND = "~";
const HOME_SHORTHAND_PREFIX = "~/";

/**
 * Where the store's folder came from:
 * `ZINN_DIR`, storage.directory in the per-codebase or the global
 *  settings file, or the default folder in the home directory.
 */
export const storageSourceSchema = z.enum(["env", "local", "global", "default"]);
export type StorageSource = z.infer<typeof storageSourceSchema>;

type StoragePaths = {
  directory: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
  logDirectory: string;
};

/** The store as configuration places it, before filesystem links are resolved. */
export type ConfiguredStorage = StoragePaths & {
  source: StorageSource;
  /** The settings file whose `storage.directory` chose the folder, or `null` when `ZINN_DIR` or the default chose it. */
  settingsPath: string | null;
  /** The default folder in the home directory, which a folder from another source may also reach. */
  defaultDirectory: string;
};

/**
 * A storage snapshot. The database and backup destinations are resolved through filesystem links,
 *  and the data folder is the resolved database's folder.
 * The log folder is left unresolved, so a broken link there fails only the log write and not every command.
 */
export type Storage = ConfiguredStorage & {
  databasePath: ResolvedPath;
  backupDirectory: ResolvedPath;
};

type StorageInputs = SettingsInputs;

/** A store's folder chosen by `storage.directory`, and the settings file that chose it. */
type SettingsChoice = {
  source: "local" | "global";
  directory: string;
  settingsPath: string;
};

/** The paths inside a store's folder */
export function storagePaths(directory: string): StoragePaths {
  const dataDirectory = join(directory, "data");

  return {
    directory,
    dataDirectory,
    databasePath: join(dataDirectory, DB_FILE_NAME),
    backupDirectory: join(directory, "backups"),
    logDirectory: join(directory, "logs"),
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
 * The folder `storage.directory` chooses, from the per-codebase file before the global one, or `null` when neither sets it.
 * A relative folder resolves against the folder of the file that sets it.
 */
function chooseFromSettings(
  { local, global }: Pick<ResolvedSettings, "global" | "local">,
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
 *  so a test that misses `ZINN_DIR` fails to prevnet it from using a real database
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
  // A folder found from process.cwd() has its real path, which can differ from tmpdir(), as /private/var does from /var on macOS
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
 * Finds the store's folder from the given inputs: `ZINN_DIR`, then `storage.directory` in the codebase's
 *  settings file, then in the global one, then the default folder.
 * The selected settings files are validated before the store is resolved.
 */
export function resolveStorage(
  inputs: StorageInputs,
  settings: Pick<ResolvedSettings, "global" | "local"> = resolveSettings(inputs),
): ConfiguredStorage {
  const { env, home } = inputs;
  const defaultDirectory = join(home, MAIN_FOLDER_NAME);

  if (env.ZINN_DIR !== undefined) {
    return {
      ...storagePaths(env.ZINN_DIR),
      source: "env",
      settingsPath: null,
      defaultDirectory,
    };
  }

  const choice = chooseFromSettings(settings, home);
  if (choice !== null) {
    refuseOutsideTemporaryInTestRun(choice.directory, env, choice.settingsPath);
    return {
      ...storagePaths(choice.directory),
      source: choice.source,
      settingsPath: choice.settingsPath,
      defaultDirectory,
    };
  }

  refuseOutsideTemporaryInTestRun(defaultDirectory, env, null);
  return {
    ...storagePaths(defaultDirectory),
    source: "default",
    settingsPath: null,
    defaultDirectory,
  };
}

let processStorage: ConfiguredStorage | null = null;
let processSettings: ResolvedSettings | null = null;

/** For internal tests, to be run after the database connection has closed. */
export function resetStorageForTests() {
  processStorage = null;
  processSettings = null;
}

function processInputs(): StorageInputs {
  return { cwd: process.cwd(), env: process.env, home: homedir() };
}

/** This process's settings, read from its working folder, environment and home directory on first use, then kept. */
export function getProcessSettings() {
  if (processSettings === null) {
    processSettings = resolveSettings(processInputs());
  }

  return processSettings;
}

/** Selected store folder must exist before any contents can be initialized. */
function assertStoreDirectory(directory: string, settingsPath: string | null) {
  const absoluteDirectory = resolve(directory);
  const source = settingsPath === null ? "ZINN_DIR" : `the settings file ${settingsPath}`;
  let problem: string | null = null;
  let cause: unknown;

  if (directory === "") {
    problem = "ZINN_DIR is empty. Set it to a folder path";
  } else {
    try {
      if (!statSync(absoluteDirectory).isDirectory()) {
        problem = "it is not a folder";
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      problem = "it does not exist";
      cause = error;
    }
  }

  if (problem !== null) {
    const quotedDirectory = `'${absoluteDirectory.replaceAll("'", "'\\''")}'`;
    throw new CoreError(
      `Cannot use ${absoluteDirectory}, chosen by ${source}: ${problem}. Create the folder with \`mkdir -p ${quotedDirectory}\`.`,
      "storage",
      {
        reason: "invalid_storage",
        path: absoluteDirectory,
        ...(settingsPath === null ? {} : { settingsPath }),
      },
      { cause },
    );
  }
}

/**
 * Captures a fresh database destination from the configuration selected on first use.
 * Settings and the selected directory stay cached. The database and backup paths are resolved through filesystem links for each snapshot.
 * Keep the snapshot throughout an operation. An open connection retains its own opening target.
 */
export function getStorage() {
  if (processStorage === null) {
    const inputs = processInputs();
    if (inputs.env.ZINN_DIR !== undefined) {
      assertStoreDirectory(inputs.env.ZINN_DIR, null);
    }

    const storage = resolveStorage(inputs, getProcessSettings());
    if (storage.source === "local" || storage.source === "global") {
      assertStoreDirectory(storage.directory, storage.settingsPath);
    }
    // Paths are anchored to the first working folder, so a later change of folder does not move the store.
    processStorage = { ...storage, ...storagePaths(resolve(inputs.cwd, storage.directory)) };
  }

  const databasePath = resolveDatabasePath(processStorage.databasePath);
  return {
    ...processStorage,
    dataDirectory: dirname(databasePath),
    databasePath,
    backupDirectory: resolveDatabasePath(processStorage.backupDirectory),
  };
}
