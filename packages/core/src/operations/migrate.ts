import type { BackupCreateInput } from "../db/backup";
import type { LockWait } from "../migrations/upgrade";

import { BACKUP_DIR, DB_PATH } from "../constant";
import { migrateDatabase } from "../migrations/migrate";

export type MigrateRunInput = BackupCreateInput & {
  /** Called once when another writer holds the database and the upgrade starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export const migrate = {
  run: ({ client, version, onWait }: MigrateRunInput) =>
    migrateDatabase(DB_PATH, { backup: { directory: BACKUP_DIR, client, version }, onWait }),
};
