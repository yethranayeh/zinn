import type { Command } from "../types";

import { parseArgs } from "node:util";
import { BACKUP_DIR, migrate, MigrationRefusedError } from "@zinn-dev/core";

import { reportLockWait } from "../database";
import { output } from "../lib";
import packageJson from "../../package.json";

export const migrateCommand = {
  run: (args) => {
    parseArgs({ args, strict: true, allowPositionals: false });

    try {
      const result = migrate.run({
        client: "cli",
        version: packageJson.version,
        onWait: reportLockWait,
      });

      output(result, (r) =>
        r.changed
          ? `Upgraded the database from schema version ${r.previousVersion} to ${r.finalVersion}. A backup was saved to ${r.backupPath}`
          : `The database is already at schema version ${r.finalVersion}`,
      );
    } catch (error) {
      // A refusal attempted nothing, so only a failed upgrade points at the backups.
      if (!(error instanceof MigrationRefusedError)) {
        console.error(
          `The database is unchanged. Backups taken before each upgrade attempt are kept in ${BACKUP_DIR}.`,
        );
      }

      throw error;
    }
  },
  help: `Usage: zinn migrate

Upgrade an existing database to the latest schema version.

A backup is saved first, in the same place as \`zinn backup\`, and the upgrade is applied completely or not at all.
Does nothing when the database is already up to date.
Fails, leaving the database as it is, when there is no database with data yet, when it has no schema version, or when it is newer than this Zinn.`,
} satisfies Command;
