import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, defaultConfig, MAIN_PATH } from "./constant";

if (!existsSync(MAIN_PATH)) {
  mkdirSync(MAIN_PATH);
}

if (!existsSync(CONFIG_PATH)) {
  writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig) + "\n", { encoding: "utf-8" });
}
