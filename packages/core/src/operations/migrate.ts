import type { BackupCreateInput } from "../db/backup.js";
import type { LockWait } from "../migrations/upgrade.js";

import { getBackupStorage } from "../storage.js";
import { migrateDatabase } from "../migrations/migrate.js";

export type MigrateRunInput = BackupCreateInput & {
  /** Called once when another writer holds the database and the upgrade starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export const migrate = {
  run: ({ client, version, onWait }: MigrateRunInput) => {
    const { databasePath, backupDirectory } = getBackupStorage();
    return migrateDatabase(databasePath, {
      backup: { directory: backupDirectory, client, version },
      onWait,
    });
  },
};
