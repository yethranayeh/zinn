import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DATA_DIR, MAIN_DIR, CONFIG_PATH, defaultConfig } from "./constant";

export function ensureConfigSetup() {
  if (!existsSync(MAIN_DIR)) {
    mkdirSync(MAIN_DIR);
  }

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR);
  }

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig) + "\n", { encoding: "utf-8" });
  }
}
