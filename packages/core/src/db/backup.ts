import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { openDatabase } from "#sqlite";

import { applyConnectionSettings } from "../connection.js";
import { attachSuppressed } from "../sqlite/database.js";

export type BackupCreateInput = {
  /**
   * The client (anything that consumes core) making the backup, recorded in the file name.
   * @example {client: "cli", version: "0.37.0"}
   */
  client: string;
  version: string;
};

/**
 * `VACUUM INTO` writes straight to its target and does not `fsync` it,
 *  so an interrupted backup can leave an **incomplete** file behind.
 * Under its final name, that file would look like a finished backup.
 * The backup is written under this suffix and renamed once it is complete and on disk.
 * @link https://www.sqlite.org/lang_vacuum.html#vacuuminto
 */
const PARTIAL_BACKUP_SUFFIX = ".partial";
/**
 * The file name `create` gives a backup: `<time>Z-<client>-<version>-<suffix>.sqlite`.
 * The client ends before the first hyphen followed by a digit, where the version starts.
 */
const BACKUP_FILE_NAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-(?<client>.+?)-(?<version>\d.*)-[0-9a-f]{8}\.sqlite$/;

function syncToDisk(path: string) {
  // Read/write, because apparently Windows only flushes a file opened for writing.
  const descriptor = openSync(path, "r+");

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Copies the database at `databasePath` to `targetPath` through a connection of its own,
 *  which does not create tables or rows,
 *  so it also copies a database that is in the process of an upgrade
 *  or that this build cannot write.
 * `VACUUM INTO` reads through SQLite, so the copy includes writes still in the WAL file.
 * It fails when the target file already exists.
 * The connection is read/write, since a read-only one cannot always open a WAL database,
 *  so it would create a missing database file.
 * Callers check that it exists.
 * @link https://www.sqlite.org/wal.html#readonly
 */
function vacuumInto(databasePath: string, targetPath: string) {
  const db = openDatabase(databasePath);

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
  databasePath: string,
  directory: string,
  { client, version }: BackupCreateInput,
) {
  mkdirSync(directory, { recursive: true });

  /**
   * Transformed UTC: 2026-09-29T12-30-05Z
   * Colons (:) are replaced to avoid illegal naming issues in filesystems
   */
  const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const suffix = randomUUID().split("-")[0];
  const path = join(directory, `${timestamp}Z-${client}-${version}-${suffix}.sqlite`);
  const partialPath = `${path}${PARTIAL_BACKUP_SUFFIX}`;

  try {
    vacuumInto(databasePath, partialPath);
    syncToDisk(partialPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }

  // A rename within one directory is atomic, so the final name only ever holds a complete backup.
  renameSync(partialPath, path);

  return { path };
}

/** The client and version named in a backup's file name, or null when `create` did not name the file. */
export function readBackupFileName(path: string): BackupCreateInput | null {
  const match = BACKUP_FILE_NAME.exec(basename(path))?.groups;

  if (match?.client == null || match.version == null) {
    return null;
  }

  return { client: match.client, version: match.version };
}
