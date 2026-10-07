import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const MAIN_FOLDER_NAME = ".zinn";
export const DB_FILE_NAME = "zinn.sqlite";

/** Where the store's folder came from: `ZINN_DIR`, or the default folder in the home directory. */
export type StorageSource = "env" | "default";

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

type StorageInputs = {
  /** Environment variables, such as `process.env`. */
  env: Record<string, string | undefined>;
  home: string;
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

/**
 * A test run (`NODE_ENV="test"`) refuses the default folder unless it is inside the temporary directory,
 *  so a test that misses `ZINN_DIR` fails instead of using the global database.
 */
function refuseDefaultInTestRun(defaultDirectory: string, env: StorageInputs["env"]) {
  if (env.NODE_ENV !== "test") {
    return;
  }

  const temporaryDirectory = tmpdir();
  const pathFromTemporary = relative(temporaryDirectory, defaultDirectory);
  const isInsideTemporary = !pathFromTemporary.startsWith("..") && !isAbsolute(pathFromTemporary);

  if (!isInsideTemporary) {
    throw new Error(
      `Refusing to use ${defaultDirectory} in a test run (NODE_ENV=test): a test's Zinn folder must be inside ${temporaryDirectory}. Set ZINN_DIR, or HOME, to a temporary folder`,
    );
  }
}

/** Finds the store's folder from the given inputs: `ZINN_DIR` when it is set, otherwise the default folder. */
export function resolveStorage({ env, home }: StorageInputs): Storage {
  const defaultDirectory = join(home, MAIN_FOLDER_NAME);

  if (env.ZINN_DIR !== undefined) {
    return { ...storagePaths(env.ZINN_DIR), source: "env", defaultDirectory };
  }

  refuseDefaultInTestRun(defaultDirectory, env);
  return { ...storagePaths(defaultDirectory), source: "default", defaultDirectory };
}

let processStorage: Storage | null = null;

/** This process's store, resolved from its environment and home directory on first use, then kept. */
export function getStorage() {
  if (processStorage === null) {
    processStorage = resolveStorage({ env: process.env, home: homedir() });
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
