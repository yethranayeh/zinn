import { CoreError } from "../errors.js";
import type { BackupCreateInput } from "../db/backup.js";
import type { LockWait } from "../migrations/upgrade.js";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as dbBackup from "../db/backup.js";
import { ensureDataDirectory } from "../config.js";
import { getStorage } from "../constant.js";
import { classifyDatabase } from "../migrations/classify.js";
import { MIGRATIONS } from "../migrations/registry.js";
import { checkBackup, restoreDatabase } from "../migrations/restore.js";

export type BackupRestoreInput = BackupCreateInput & {
  /** The backup file to restore. */
  path: string;
  /** Called once when another writer holds the database and the restore starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export type { BackupCreateInput };
export const backup = {
  create: (input: BackupCreateInput) => {
    const { databasePath, backupDirectory } = getStorage();
    const { state } = classifyDatabase(databasePath);

    if (state === "absent" || state === "empty") {
      throw new CoreError(`There is no Zinn database at ${databasePath} to back up`, "missing", {
        entity: "database",
        databasePath,
      });
    }

    return dbBackup.create(databasePath, backupDirectory, input);
  },
  /**
   * Throws `RestoreRefusedError` for a backup that `restore` would refuse, without opening the database.
   * `restore` checks again, so a client can call this before asking for confirmation.
   */
  check: ({ path, client, version }: Omit<BackupRestoreInput, "onWait">) =>
    checkBackup(resolve(path), MIGRATIONS, { client, version }),
  /** Replaces the database contents from a backup, saving the current database first. */
  restore: ({ path, client, version, onWait }: BackupRestoreInput) => {
    const { databasePath, backupDirectory } = getStorage();
    const isNewStore = !existsSync(databasePath);
    const result = restoreDatabase(databasePath, resolve(path), {
      backup: { directory: backupDirectory, client, version },
      onWait,
    });

    // A store the restore creates gets the same data directory as one created by opening it.
    if (isNewStore) {
      ensureDataDirectory();
    }

    return result;
  },
};
