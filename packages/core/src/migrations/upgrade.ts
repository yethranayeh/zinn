/**
 * Upgrades a database file under SQLite's write lock, held by connection A, the one passed in,
 *  so callers that arrive together take turns and each rereads the version once it has the lock.
 * Before A writes anything, a second connection, B, snapshots the file into the backup directory.
 */
import type { BackupCreateInput } from "../db/backup.js";
import type { ResolvedPath } from "../database-path.js";
import type { Database } from "../sqlite/database.js";
import type { Migration } from "./registry.js";
import type { FreeSpace } from "./space.js";

import { mkdirSync } from "node:fs";

import * as dbBackup from "../db/backup.js";
import { CoreError } from "../errors.js";
import { isSqliteErrorFamily } from "../sqlite/database.js";
import { checkAutomaticUpgrade, markPausingFailure, readOwnPause, removePause } from "./pause.js";
import { assertMigrationOrder, latestVersion, MIGRATIONS } from "./registry.js";
import {
  applyPendingMigrations,
  assertOutsideTransaction,
  assertUpgradable,
  readSchemaVersion,
  withForeignKeysOff,
} from "./runner.js";
import {
  assertFreeSpace,
  estimateRequiredFree,
  measureSpace,
  readFreeSpace,
  requireDatabaseFile,
  spacePathsFor,
} from "./space.js";

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

  return new CoreError(
    `Waited ${seconds} seconds for another writer to finish with the database at ${databasePath}, so this ${operation} stopped and applied no changes. Retry once the other writer finishes.`,
    "storage",
    { entity: "database", databasePath, reason: "busy" },
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
        const isLockBusy = !workStarted && isSqliteErrorFamily(error, "SQLITE_BUSY");

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
  backup: BackupCreateInput & { directory: string | (() => string) };
  /** Only an ordinary database open honors and records an automatic upgrade pause. */
  automatic?: boolean;
  migrations?: ReadonlyArray<Migration>;
  /** Reads a filesystem's free space. Tests pass their own, so no test fills the disk. */
  readFreeSpace?: (path: string) => FreeSpace | null;
};

/**
 * Removes the pause record read before a committed upgrade or restore, unless another attempt replaced it.
 * Best effort: the commit changed the schema version or the schema itself, so a record left behind
 *  no longer matches the database and pauses nothing.
 */
export function clearCommittedPause(
  db: Database,
  databasePath: ResolvedPath,
  { budgetMs }: LockOptions,
  record: string | null,
) {
  if (record === null) {
    return;
  }

  try {
    // No wait notice: the caller's change is already done
    withMigrationLock(db, databasePath, { budgetMs, operation: "upgrade record cleanup" }, () => {
      removePause(databasePath, record);
    });
  } catch {
    // The record no longer pauses anything, so the committed change stands without its removal
  }
}

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
 * Brings the database behind db to the latest schema version, backing it up first.
 * Under the write lock, with foreign keys off, it rereads the version, and
 *  a "current" or "newer" database is released untouched, with no backup.
 * An older one gets a free-space check, a snapshot through a separate connection while db
 *  holds the lock without writing, a second free-space check for the remaining work,
 *  then every pending migration and the version bump in the same transaction.
 * Failures through commit roll back the transaction and are thrown as they were,
 * while a finished snapshot is kept, and nothing is retried.
 * Foreign keys are set back on every path.
 * Refuses an unmarked database (version 0) before making a backup.
 */
export function upgradeDatabase(
  db: Database,
  {
    backup,
    automatic = false,
    migrations = MIGRATIONS,
    readFreeSpace: readFree = readFreeSpace,
    ...lock
  }: UpgradeOptions,
): UpgradeResult {
  assertMigrationOrder(migrations);

  const databasePath = requireDatabaseFile(db, "schema upgrade");
  const targetVersion = latestVersion(migrations);
  let completedPause: string | null = null;
  let backupCompleted = false;

  const runUpgrade = () =>
    withForeignKeysOff(db, () =>
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

        const attempt = automatic
          ? checkAutomaticUpgrade(db, databasePath, version, targetVersion)
          : undefined;
        const directory =
          typeof backup.directory === "function" ? backup.directory() : backup.directory;
        const spacePaths = spacePathsFor(databasePath, directory);

        // The free space of a missing directory is unknown, which would stop the upgrade.
        mkdirSync(directory, { recursive: true });
        const before = estimateRequiredFree(measureSpace(db, migrations), { includeBackup: true });
        assertFreeSpace(spacePaths, before, readFree);

        // db holds the write lock and has written nothing, so the snapshot is the database as it is.
        const { path: backupPath } = dbBackup.create(
          databasePath,
          directory,
          backup,
          attempt?.beforePublish,
        );
        backupCompleted = true;
        attempt?.confirmed(backupPath);

        const after = estimateRequiredFree(measureSpace(db, migrations), { includeBackup: false });
        assertFreeSpace(spacePaths, after, readFree);

        const changed = applyPendingMigrations(db, migrations, version);
        completedPause = readOwnPause(databasePath);
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

  let result: UpgradeResult;
  try {
    result = runUpgrade();
  } catch (error) {
    const backupWasPublished =
      backupCompleted || error instanceof dbBackup.BackupDirectorySyncError;
    if (automatic && backupWasPublished) {
      markPausingFailure(error);
    }
    throw error;
  }

  clearCommittedPause(db, databasePath, lock, completedPause);
  return result;
}
