import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { BACKUP_DIR, DB_PATH } from "../constant";

import * as dbBackup from "../db/backup";

/**
 * VACUUM INTO writes straight to its target and does not fsync it,
 *  so an interrupted backup can leave an incomplete file behind.
 * Under its final name, that file would look like a finished backup.
 * Opened read-write with its leftover journal, it even rolls back to an empty database.
 * The backup is written under this suffix and renamed once it is complete and on disk.
 * @link https://www.sqlite.org/lang_vacuum.html#vacuuminto
 */
const PARTIAL_BACKUP_SUFFIX = ".partial";

function syncToDisk(path: string) {
  // Read-write, because Windows only flushes a file opened for writing.
  const descriptor = openSync(path, "r+");

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type BackupCreateInput = {
  // The client (anything that consumes core) making the backup, recorded in the file name,
  // e.g. "cli" and "0.32.0".
  client: string;
  version: string;
};

export const backup = {
  create: ({ client, version }: BackupCreateInput) => {
    if (!existsSync(DB_PATH)) {
      throw new Error(`There is no Zinn database at ${DB_PATH} to back up`);
    }

    mkdirSync(BACKUP_DIR, { recursive: true });

    /**
     * Transformed UTC: 2026-09-29T12-30-05Z
     * Colons (:) are replaced to avoid illegal naming issues in filesystems
     */
    const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    const suffix = randomUUID().split("-")[0];
    const path = join(BACKUP_DIR, `${timestamp}Z-${client}-${version}-${suffix}.sqlite`);
    const partialPath = `${path}${PARTIAL_BACKUP_SUFFIX}`;

    try {
      dbBackup.create(partialPath);
      syncToDisk(partialPath);
    } catch (error) {
      rmSync(partialPath, { force: true });
      throw error;
    }

    // A rename within one directory is atomic, so the final name only ever holds a complete backup.
    renameSync(partialPath, path);

    return { path };
  },
};
