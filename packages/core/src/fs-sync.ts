import { closeSync, fsyncSync, openSync } from "node:fs";

import { attachSuppressed } from "./sqlite/database.js";

export function syncToDisk(path: string, flags: "r" | "r+" = "r+") {
  // Windows file flushes need a writable descriptor
  const descriptor = openSync(path, flags);

  try {
    fsyncSync(descriptor);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }

  closeSync(descriptor);
}

export function syncDirectory(directory: string) {
  // Windows has no directory fsync through `node:fs`
  if (process.platform !== "win32") {
    syncToDisk(directory, "r");
  }
}
