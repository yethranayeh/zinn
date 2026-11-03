import type { BackupCreateInput } from "../db/backup.js";
import type { Storage } from "../storage.js";
import type { LockWait } from "../migrations/upgrade.js";

import { resolve } from "node:path";

import * as dbBackup from "../db/backup.js";
import { CoreError } from "../errors.js";
import { getStorage } from "../storage.js";
import { classifyDatabase } from "../migrations/classify.js";
import { checkBackup, restoreDatabase } from "../migrations/restore.js";
import { MIGRATIONS } from "../migrations/registry.js";

export type BackupRestoreInput = BackupCreateInput & {
  /** The backup file to restore. */
  path: string;
  /** A destination captured before confirmation. Omit to capture one when restore starts. */
  storage?: Storage;
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
  check: ({ path, client, version }: Omit<BackupRestoreInput, "onWait" | "storage">) =>
    checkBackup(resolve(path), MIGRATIONS, { client, version }),
  /** Replaces the database contents from a backup, saving the current database first. */
  restore: ({ path, client, version, onWait, storage = getStorage() }: BackupRestoreInput) => {
    const { databasePath, backupDirectory } = storage;
    return restoreDatabase(
      databasePath,
      resolve(path),
      { backup: { directory: backupDirectory, client, version }, onWait },
    );
  },
};
