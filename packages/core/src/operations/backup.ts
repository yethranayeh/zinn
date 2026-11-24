import type { BackupCreateInput } from "../db/backup.js";
import type { BackupStorage } from "../storage.js";
import type { LockWait } from "../migrations/upgrade.js";

import { resolve } from "node:path";
import { openDatabase } from "#sqlite";

import * as dbBackup from "../db/backup.js";
import { CoreError } from "../errors.js";
import { getBackupStorage } from "../storage.js";
import { checkIntegrity, classifyDatabase } from "../migrations/classify.js";
import { checkBackup, restoreDatabase } from "../migrations/restore.js";
import { MIGRATIONS } from "../migrations/registry.js";
import { findForeignKeyViolations } from "../migrations/runner.js";
import { attachSuppressed } from "../sqlite/database.js";

export type BackupRestoreInput = BackupCreateInput & {
  /** The backup file to restore. */
  path: string;
  /** A destination captured before confirmation. Omit to capture one when restore starts. */
  storage?: BackupStorage;
  /** Called once when another writer holds the database and the restore starts waiting. */
  onWait?: (wait: LockWait) => void;
};

function verifySnapshot(path: string) {
  const db = openDatabase(path, { readonly: true });
  try {
    const { isSound, rows } = checkIntegrity(db);
    if (!isSound) {
      throw new Error(`SQLite integrity check did not report ok: ${rows.join(", ")}`);
    }

    const violations = findForeignKeyViolations(db);
    if (violations.length > 0) {
      const links = new Set(violations.map(({ table, parent }) => `${table} to ${parent}`));

      throw new Error(
        `SQLite found ${violations.length} foreign key violations (${[...links].join(", ")})`,
      );
    }
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

export type { BackupCreateInput };
export const backup = {
  /** Saves a snapshot after checking its SQLite integrity and foreign keys */
  create: (input: BackupCreateInput) => {
    const { databasePath, backupDirectory } = getBackupStorage();
    const { state } = classifyDatabase(databasePath);

    if (state === "absent" || state === "empty") {
      throw new CoreError(`There is no Zinn database at ${databasePath} to back up`, "missing", {
        entity: "database",
        databasePath,
      });
    }

    return dbBackup.create(databasePath, backupDirectory, input, { verify: verifySnapshot });
  },
  /**
   * Throws `RestoreRefusedError` for a backup that `restore` would refuse, without opening the database.
   * `restore` checks again, so a client can call this before asking for confirmation.
   */
  check: ({
    path,
    client,
    version,
    storage = getBackupStorage(),
  }: Omit<BackupRestoreInput, "onWait">) =>
    checkBackup(resolve(path), MIGRATIONS, { client, version }, storage.databasePath),
  /** Replaces the database contents from a backup, saving the current database first. */
  restore: ({
    path,
    client,
    version,
    onWait,
    storage = getBackupStorage(),
  }: BackupRestoreInput) => {
    const { databasePath, backupDirectory } = storage;
    return restoreDatabase(databasePath, resolve(path), {
      backup: { directory: backupDirectory, client, version },
      onWait,
    });
  },
};
