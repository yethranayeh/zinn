import { homedir } from "node:os";
import { join } from "node:path";

export const MAIN_FOLDER_NAME = ".zinn";
export const DB_FILE_NAME = "zinn.sqlite";

export const DEFAULT_MAIN_DIR = join(homedir(), MAIN_FOLDER_NAME);
export const MAIN_DIR = process.env.ZINN_DIR ?? DEFAULT_MAIN_DIR;
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
