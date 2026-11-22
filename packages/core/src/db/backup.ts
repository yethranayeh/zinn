import type { ResolvedPath } from "../database-path.js";

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { openResolvedDatabase } from "#sqlite";

import { applyConnectionSettings } from "../connection.js";
import { CoreError, errorMessage } from "../errors.js";
import { syncDirectory, syncToDisk } from "../fs-sync.js";
import { createOutputFileName, readOutputFileName } from "../output-file-name.js";
import { attachSuppressed } from "../sqlite/database.js";

export type BackupCreateInput = {
  /**
   * The client (anything that consumes core) making the backup, recorded in the file name.
   * @example {client: "cli", version: "0.37.0"}
   */
  client: string;
  version: string;
};

export class BackupDirectorySyncError extends CoreError {
  override name = "BackupDirectorySyncError";

  constructor(backupPath: string, cause: unknown) {
    super(
      `Could not finish syncing the backup directory (${errorMessage(cause)}). The backup is at ${backupPath}. Its final name may be lost in a crash`,
      "storage",
      { entity: "backup", backupPath },
      { cause },
    );
  }
}

/**
 * `VACUUM INTO` writes straight to its target,
 *  so an interrupted backup can leave an **incomplete** file behind.
 * Under its final name, that file would look like a finished backup.
 * The backup is written under this suffix and renamed once it is complete and on disk.
 * @link https://www.sqlite.org/lang_vacuum.html#vacuuminto
 */
const PARTIAL_BACKUP_SUFFIX = ".partial";
const BACKUP_FILE_EXTENSION = ".sqlite";

/** Creates the backup directory and syncs the parent entries that make it reachable. */
function ensureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true });

  if (process.platform === "win32") {
    return;
  }

  // Existing ancestors may have been created by a concurrent or failed attempt.
  let parent = dirname(resolve(directory));

  for (;;) {
    syncDirectory(parent);
    const ancestor = dirname(parent);

    if (ancestor === parent) {
      break;
    }

    parent = ancestor;
  }
}

/**
 * Copies the database at `databasePath` to `targetPath` through a connection of its own,
 *  which does not create tables or rows,
 *  so it also copies a database that is in the process of an upgrade
 *  or that this build cannot write.
 * `VACUUM INTO` reads through SQLite, so the copy includes writes still in the WAL file.
 * It fails when the target file already exists.
 * The connection opens an existing database read/write, since a read-only one
 * cannot always open a WAL database.
 * @link https://www.sqlite.org/wal.html#readonly
 */
function vacuumInto(databasePath: ResolvedPath, targetPath: string) {
  const db = openResolvedDatabase(databasePath, { create: false });

  try {
    applyConnectionSettings(db);
    db.query("VACUUM INTO ?").run(targetPath);
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }

  db.close();
}

/**
 * Snapshots the database at `databasePath` into directory, named after the time, the client
 *  and its version, and returns the snapshot's path.
 */
export function create(
  databasePath: ResolvedPath,
  directory: string,
  { client, version }: BackupCreateInput,
  beforePublish?: (path: string) => void,
) {
  ensureDirectory(directory);
  const path = join(directory, createOutputFileName({ client, version }, BACKUP_FILE_EXTENSION));
  const partialPath = `${path}${PARTIAL_BACKUP_SUFFIX}`;

  try {
    vacuumInto(databasePath, partialPath);
    syncToDisk(partialPath);
    beforePublish?.(path);
    // A rename within one directory is atomic, so the final name only ever holds a complete backup
    renameSync(partialPath, path);
  } catch (error) {
    try {
      rmSync(partialPath, { force: true });
    } catch (cleanupError) {
      attachSuppressed(error, cleanupError);
    }

    throw error;
  }

  // The name needs a directory sync too. https://man7.org/linux/man-pages/man2/fsync.2.html
  try {
    syncDirectory(directory);
  } catch (error) {
    throw new BackupDirectorySyncError(path, error);
  }

  return { path };
}

/** The client and version named in a backup's file name, or null when `create` did not name the file. */
export function readBackupFileName(path: string): BackupCreateInput | null {
  return readOutputFileName(path, BACKUP_FILE_EXTENSION);
}
