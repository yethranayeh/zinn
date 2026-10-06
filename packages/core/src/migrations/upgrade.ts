/**
 * Upgrades a database file under SQLite's write lock, held by connection A, the one passed in,
 *  so callers that arrive together take turns and each rereads the version once it has the lock.
 * Before A writes anything, a second connection, B, snapshots the file into the backup directory.
 */
import type { BackupCreateInput } from "../db/backup";
import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";
import type { FreeSpace, SpacePaths } from "./space";

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import * as dbBackup from "../db/backup";
import { SqliteError } from "../sqlite/database";
import { assertMigrationOrder, latestVersion, MIGRATIONS } from "./registry";
import {
  applyPendingMigrations,
  assertOutsideTransaction,
  assertUpgradable,
  readSchemaVersion,
  withForeignKeysOff,
} from "./runner";
import {
  assertFreeSpace,
  estimateRequiredFree,
  measureSpace,
  readDatabaseFile,
  readFreeSpace,
} from "./space";

/**
 * How long a caller waits in total for another writer to release the database.
 * It limits waiting for the lock only, so an upgrade that holds the lock runs to the end.
 */
export const MIGRATION_LOCK_BUDGET_MS = 30_000;
/**
 * Pause before trying again when SQLite reports the lock busy without waiting for it,
 *  which it does instead of calling the busy handler when waiting could deadlock.
 * @link https://www.sqlite.org/c3ref/busy_handler.html
 */
const LOCK_RETRY_PAUSE_MS = 20;
/** The first attempt does not wait, so a wait is reported only when another writer has the lock. */
const NO_WAIT_MS = 0;
const MS_PER_SECOND = 1000;

export type LockWait = { databasePath: string; budgetMs: number };

export type LockOptions = {
  /** Total time to wait for the lock. */
  budgetMs?: number;
  /** Called once, when another writer holds the lock and this caller starts waiting for it. */
  onWait?: (wait: LockWait) => void;
};

function readBusyTimeout(db: Database) {
  return db.query<{ timeout: number }>("PRAGMA busy_timeout").get()!.timeout;
}

function setBusyTimeout(db: Database, milliseconds: number) {
  // The value is a whole number of milliseconds, as PRAGMA takes no bound parameters.
  db.exec(`PRAGMA busy_timeout = ${Math.ceil(milliseconds)}`);
}

function isBusy(error: unknown) {
  return error instanceof SqliteError && error.code.startsWith("SQLITE_BUSY");
}

function pause(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockTimeoutError(
  databasePath: string,
  operation: string,
  waitedMs: number,
  cause: unknown,
) {
  const seconds = (waitedMs / MS_PER_SECOND).toFixed(1);

  return new Error(
    `Waited ${seconds} seconds for another writer to finish with the database at ${databasePath}, so this ${operation} stopped and applied no changes. Retry once the other writer finishes.`,
    { cause },
  );
}

/**
 * Runs work inside a `BEGIN IMMEDIATE` transaction on db, which takes SQLite's write lock,
 *  and commits. Waiting for another writer to release the lock shares one budget.
 *  SQLite's busy timeout restarts on every attempt, so each attempt waits only for the time left.
 * A busy error from work itself is thrown as it is: work never runs twice.
 * The connection's busy timeout is set back before work runs.
 */
export function withMigrationLock<T>(
  db: Database,
  databasePath: string,
  {
    budgetMs = MIGRATION_LOCK_BUDGET_MS,
    onWait,
    operation = "schema upgrade",
  }: LockOptions & {
    /** What the timeout error says stopped. */
    operation?: string;
  },
  work: () => T,
): T {
  assertOutsideTransaction(db);

  const callerBusyTimeout = readBusyTimeout(db);
  const began = performance.now();
  let isWaiting = false;
  let workStarted = false;
  let lastBusyError: unknown = null;

  try {
    for (;;) {
      const waitedMs = performance.now() - began;
      const remainingMs = budgetMs - waitedMs;

      if (isWaiting && remainingMs <= 0) {
        throw lockTimeoutError(databasePath, operation, waitedMs, lastBusyError);
      }

      setBusyTimeout(db, isWaiting ? remainingMs : NO_WAIT_MS);

      try {
        return db
          .transaction(() => {
            workStarted = true;
            setBusyTimeout(db, callerBusyTimeout);
            return work();
          })
          .immediate();
      } catch (error) {
        const isLockBusy = !workStarted && isBusy(error);

        if (!isLockBusy) {
          throw error;
        }

        lastBusyError = error;

        if (isWaiting) {
          const leftMs = budgetMs - (performance.now() - began);
          pause(Math.max(0, Math.min(LOCK_RETRY_PAUSE_MS, leftMs)));
        } else {
          isWaiting = true;
          onWait?.({ databasePath, budgetMs });
        }
      }
    }
  } finally {
    if (!workStarted) {
      setBusyTimeout(db, callerBusyTimeout);
    }
  }
}

export type UpgradeOptions = LockOptions & {
  /** Where the snapshot goes, and the client named in its file name. */
  backup: BackupCreateInput & { directory: string };
  migrations?: ReadonlyArray<Migration>;
  /** Reads a filesystem's free space. Tests pass their own, so no test fills the disk. */
  readFreeSpace?: (path: string) => FreeSpace | null;
};

export type UpgradeResult = {
  /** "newer": this build is older than the database, which it leaves untouched. */
  status: "current" | "newer" | "upgraded";
  databasePath: string;
  /** The version found under the lock, after any other caller's upgrade. */
  previousVersion: number;
  finalVersion: number;
  changed: boolean;
  /** The snapshot this caller took, null unless it upgraded. */
  backupPath: string | null;
};

/**
 * SQLite writes its temporary files to `SQLITE_TMPDIR` when set, otherwise to the system's
 *  temporary directory.
 * @link https://www.sqlite.org/tempfiles.html#temporary_file_storage_locations
 */
export function temporaryDirectory() {
  return process.env.SQLITE_TMPDIR ?? tmpdir();
}

/**
 * Brings the database behind db to the latest schema version, backing it up first.
 * Under the write lock, with foreign keys off, it rereads the version, and
 *  a "current" or "newer" database is released untouched, with no backup.
 * An older one gets a free-space check, a snapshot through a separate connection while db
 *  holds the lock without writing, a second free-space check for the remaining work,
 *  then every pending migration and the version bump in the same transaction.
 * Any failure rolls back the transaction and is thrown as it was,
 * while a finished snapshot is kept, and nothing is retried.
 * Foreign keys are set back on every path.
 * Refuses an unmarked database (version 0) before making a backup.
 */
export function upgradeDatabase(
  db: Database,
  {
    backup,
    migrations = MIGRATIONS,
    readFreeSpace: readFree = readFreeSpace,
    ...lock
  }: UpgradeOptions,
): UpgradeResult {
  assertMigrationOrder(migrations);

  const databasePath = readDatabaseFile(db);
  if (databasePath == null) {
    throw new Error(
      "The schema upgrade backs up the database file first, and this database has no file",
    );
  }

  const targetVersion = latestVersion(migrations);
  const spacePaths: SpacePaths = {
    database: dirname(databasePath),
    backup: backup.directory,
    temporary: temporaryDirectory(),
  };

  return withForeignKeysOff(db, () =>
    withMigrationLock(db, databasePath, lock, (): UpgradeResult => {
      // Another caller may have upgraded the database while this one waited for the lock.
      const version = readSchemaVersion(db);
      const unchanged = {
        databasePath,
        previousVersion: version,
        finalVersion: version,
        changed: false,
        backupPath: null,
      };

      if (version === targetVersion) {
        return { status: "current", ...unchanged };
      }

      if (version > targetVersion) {
        return { status: "newer", ...unchanged };
      }

      assertUpgradable(version, migrations);

      // The free space of a missing directory is unknown, which would stop the upgrade.
      mkdirSync(backup.directory, { recursive: true });
      const before = estimateRequiredFree(measureSpace(db, migrations), { includeBackup: true });
      assertFreeSpace(spacePaths, before, readFree);

      // db holds the write lock and has written nothing, so the snapshot is the database as it is.
      const { path: backupPath } = dbBackup.create(databasePath, backup.directory, backup);

      const after = estimateRequiredFree(measureSpace(db, migrations), { includeBackup: false });
      assertFreeSpace(spacePaths, after, readFree);

      const changed = applyPendingMigrations(db, migrations, version);
      return {
        status: "upgraded",
        databasePath,
        previousVersion: version,
        finalVersion: targetVersion,
        changed,
        backupPath,
      };
    }),
  );
}
