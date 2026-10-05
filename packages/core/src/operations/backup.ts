import type { BackupCreateInput } from "../db/backup";

import { existsSync } from "node:fs";

import * as dbBackup from "../db/backup";
import { BACKUP_DIR, DB_PATH } from "../constant";

export type { BackupCreateInput };
export const backup = {
  create: (input: BackupCreateInput) => {
    if (!existsSync(DB_PATH)) {
      throw new Error(`There is no Zinn database at ${DB_PATH} to back up`);
    }

    return dbBackup.create(DB_PATH, BACKUP_DIR, input);
  },
};
