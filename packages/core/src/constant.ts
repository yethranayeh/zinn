import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const MAIN_FOLDER_NAME = ".zinn";
export const DB_FILE_NAME = "zinn.sqlite";

export const DEFAULT_MAIN_DIR = join(homedir(), MAIN_FOLDER_NAME);

/**
 * The default folder. A test run (`NODE_ENV="test"`) refuses it unless it is inside the
 *  temporary directory, so a test that misses `ZINN_DIR` fails instead of using the global database.
 */
function defaultMainDir() {
  if (process.env.NODE_ENV !== "test") {
    return DEFAULT_MAIN_DIR;
  }

  const temporaryDirectory = tmpdir();
  const pathFromTemporary = relative(temporaryDirectory, DEFAULT_MAIN_DIR);
  const isInsideTemporary = !pathFromTemporary.startsWith("..") && !isAbsolute(pathFromTemporary);

  if (!isInsideTemporary) {
    throw new Error(
      `Refusing to use ${DEFAULT_MAIN_DIR} in a test run (NODE_ENV=test): a test's Zinn folder must be inside ${temporaryDirectory}. Set ZINN_DIR, or HOME, to a temporary folder`,
    );
  }

  return DEFAULT_MAIN_DIR;
}

export const MAIN_DIR = process.env.ZINN_DIR ?? defaultMainDir();
export const DATA_DIR = join(MAIN_DIR, "data");
// TODO: environment variable based path overriding for tests
export const DB_PATH = join(DATA_DIR, DB_FILE_NAME);
export const BACKUP_DIR = join(MAIN_DIR, "backups");
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
