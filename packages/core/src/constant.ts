import { homedir } from "node:os";
import { join } from "node:path";

export const MAIN_FOLDER_NAME = ".zinn";
export const CONFIG_FILE_NAME = "settings.json";
export const DB_FILE_NAME = "zinn.sqlite";

export const MAIN_DIR = process.env.ZINN_DIR ?? join(homedir(), MAIN_FOLDER_NAME);
export const CONFIG_PATH = join(MAIN_DIR, CONFIG_FILE_NAME);
export const DATA_DIR = join(MAIN_DIR, "data");
// TODO: environment variable based path overriding for tests
export const DB_PATH = join(DATA_DIR, DB_FILE_NAME);
export const DB_TABLE = {
  project: "project",
  projectColumn: "project_column",
  task: "task",
  task_relations: "task_relations",
};

// TODO: implement zod schema for setting.json
export const defaultConfig = {};
