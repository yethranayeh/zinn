import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { BACKUP_DIR, DB_PATH } from "../constant";

import * as dbBackup from "../db/backup";

export type BackupCreateInput = {
  // The client (anything that consumes core) making the backup, recorded in the file name,
  // e.g. "cli" and "0.32.0".
  client: string;
  version: string;
};

export const backup = {
  create: ({ client, version }: BackupCreateInput) => {
    if (!existsSync(DB_PATH)) {
      throw new Error(`There is no Zinn database at ${DB_PATH} to back up`);
    }

    mkdirSync(BACKUP_DIR, { recursive: true });

    /**
     * Transformed UTC: 2026-09-29T12-30-05Z
     * Colons (:) are replaced to avoid illegal naming issues in filesystems
     */
    const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    const suffix = randomUUID().split("-")[0];
    const path = join(BACKUP_DIR, `${timestamp}Z-${client}-${version}-${suffix}.sqlite`);

    dbBackup.create(path);

    return { path };
  },
};
