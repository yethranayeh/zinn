import type { Database } from "./sqlite/database";

const BUSY_TIMEOUT_MS = 30_000;
/**
 * In WAL mode, synchronous NORMAL skips the fsync on each commit, so a power loss or OS crash
 *  can undo the last commits that were reported as done. FULL syncs the WAL on every commit.
 * Node's SQLite already defaults to FULL, and the SQLite that Bun uses on macOS defaults to NORMAL.
 * @link https://www.sqlite.org/pragma.html#pragma_synchronous
 */
const SYNCHRONOUS_FULL = "FULL";
/**
 * On macOS, fsync hands data to the drive, which may still hold it in a volatile cache,
 *  so a power loss can undo commits even with synchronous FULL.
 * fullfsync makes SQLite use F_FULLFSYNC, which waits until the drive has stored the data,
 *  for every sync including checkpoints. Other platforms ignore it.
 * Measured on an internal Apple SSD on 2026-10-04: about 0.75 ms more per write command.
 * @link https://www.sqlite.org/pragma.html#pragma_fullfsync
 */
const FULLFSYNC_ON = "ON";

/**
 * Waiting and durability settings for every connection to a Zinn database,
 *  including ones that create no tables, such as the backup's.
 * Closing the last connection to a database copies the WAL file into it, so these apply there too.
 */
export function applyConnectionSettings(db: Database) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec(`PRAGMA synchronous = ${SYNCHRONOUS_FULL};`);
  db.exec(`PRAGMA fullfsync = ${FULLFSYNC_ON};`);
}
