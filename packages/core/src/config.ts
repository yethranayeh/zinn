import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./constant";

/**
 * Creates the data directory and any missing parents.
 * `recursive` so that a directory that already exists is not an error.
 */
export function ensureDataDirectory() {
  mkdirSync(DATA_DIR, { recursive: true });
}
