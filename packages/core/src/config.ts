import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAIN_FOLDER_NAME = ".zinn";
const CONFIG_FILE_NAME = "settings.json";

const MAIN_PATH = join(homedir(), MAIN_FOLDER_NAME);
const CONFIG_PATH = join(MAIN_PATH, CONFIG_FILE_NAME);

const defaultConfig = {};

if (!existsSync(MAIN_PATH)) {
  mkdirSync(MAIN_PATH);
}

if (!existsSync(CONFIG_PATH)) {
  writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig) + "\n", { encoding: "utf-8" });
}
