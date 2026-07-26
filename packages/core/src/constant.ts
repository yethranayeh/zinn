import { homedir } from "node:os";
import { join } from "node:path";

export const MAIN_FOLDER_NAME = ".zinn";
export const CONFIG_FILE_NAME = "settings.json";

export const MAIN_PATH = join(homedir(), MAIN_FOLDER_NAME);
export const CONFIG_PATH = join(MAIN_PATH, CONFIG_FILE_NAME);

export const defaultConfig = {};
