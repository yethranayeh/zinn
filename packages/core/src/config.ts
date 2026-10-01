import { mkdirSync, writeFileSync } from "node:fs";
import { DATA_DIR, CONFIG_PATH, defaultConfig } from "./constant";

export function ensureConfigSetup() {
  mkdirSync(DATA_DIR, { recursive: true });

  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
}
