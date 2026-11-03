import type { Storage } from "./storage.js";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getStorage } from "./storage.js";

/**
 * Creates the data directory and any missing parents.
 * `recursive` so that a directory that already exists is not an error.
 */
export function ensureDataDirectory(storage: Storage = getStorage()) {
  mkdirSync(dirname(storage.databasePath), { recursive: true });
}
