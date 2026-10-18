import type { PresentedMigrate } from "../result-schemas.js";
import type { Command } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { migrate, MigrationRefusedError, getStorage } from "@zinn-dev/core";

import { generateCommandUsage, noInput } from "../input.js";
import { reportLockWait } from "../database.js";
import { diagnostic, output, validatePositionals } from "../lib.js";
import packageJson from "../../package.json" with { type: "json" };

export const migrateCommand = {
  summary: "Upgrade an existing database to the latest schema version.",
  effects: { domain: "none", storage: "migrate" },
  confirmation: { kind: "none" },
  input: noInput,
  results: [jsonResult("Migrate")],
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);

    // Resolved before the try, so a store that cannot be resolved fails without the note about backups.
    const { backupDirectory } = getStorage();

    try {
      const result: PresentedMigrate = migrate.run({
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
        diagnostic(
          `The database is unchanged. Backups taken before each upgrade attempt are kept in ${backupDirectory}.`,
        );
      }

      throw error;
    }
  },
  help: `${generateCommandUsage("migrate", noInput)}

Upgrade an existing database to the latest schema version.

A backup is saved first, in the same place as \`zinn backup\`, and the upgrade is applied completely or not at all.
Does nothing when the database is already up to date.
Fails, leaving the database as it is, when there is no database with data yet, when it has no schema version, or when it is newer than this Zinn.`,
} satisfies Command;
