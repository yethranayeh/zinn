import { mkdirSync } from "node:fs";

/**
 * Creates a folder if its store exists.
 * ! It never creates the store, which **read** commands avoid
 */
export function ensureFolderInStore(folder: string) {
  try {
    mkdirSync(folder);
  } catch (error) {
    const alreadyExists = (error as NodeJS.ErrnoException).code === "EEXIST";
    if (!alreadyExists) {
      throw error;
    }
  }
}
