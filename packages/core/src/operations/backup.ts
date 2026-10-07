import type { BackupCreateInput } from "../db/backup";
import type { LockWait } from "../migrations/upgrade";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as dbBackup from "../db/backup";
import { ensureDataDirectory } from "../config";
import { BACKUP_DIR, DB_PATH } from "../constant";
import { classifyDatabase } from "../migrations/classify";
import { MIGRATIONS } from "../migrations/registry";
import { checkBackup, restoreDatabase } from "../migrations/restore";

export type BackupRestoreInput = BackupCreateInput & {
  /** The backup file to restore. */
  path: string;
  /** Called once when another writer holds the database and the restore starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export type { BackupCreateInput };
export const backup = {
  create: (input: BackupCreateInput) => {
    const { state } = classifyDatabase(DB_PATH);

    if (state === "absent" || state === "empty") {
      throw new Error(`There is no Zinn database at ${DB_PATH} to back up`);
    }

    return dbBackup.create(DB_PATH, BACKUP_DIR, input);
  },
  /**
   * Throws `RestoreRefusedError` for a backup that `restore` would refuse, without opening the database.
   * `restore` checks again, so a client can call this before asking for confirmation.
   */
  check: ({ path, client, version }: Omit<BackupRestoreInput, "onWait">) =>
    checkBackup(resolve(path), MIGRATIONS, { client, version }),
  /** Replaces the board with the backup's, saving the replaced board as a backup first. */
  restore: ({ path, client, version, onWait }: BackupRestoreInput) => {
    const isNewStore = !existsSync(DB_PATH);
    const result = restoreDatabase(DB_PATH, resolve(path), {
      backup: { directory: BACKUP_DIR, client, version },
      onWait,
    });

    // A store the restore creates gets the same data directory as one created by opening it.
    if (isNewStore) {
      ensureDataDirectory();
    }

    return result;
  },
};
