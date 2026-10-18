import type { PresentedRestore } from "../result-schemas.js";
import type { Command } from "../types.js";
import type { CommandInput } from "../input.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { backup, RestoreRefusedError, getStorage } from "@zinn-dev/core";

import { reportLockWait } from "../database.js";
import { confirmationDescription } from "../lib.js";
import { generateCommandUsage } from "../input.js";
import {
  askConfirmation,
  diagnostic,
  output,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import packageJson from "../../package.json" with { type: "json" };

const build = { client: "cli", version: packageJson.version };

const restoreInputs = {
  command: {
    options: { yes: { type: "boolean" } },
    forms: [
      { id: "default", positionals: [{ name: "path", min: 1, max: 1, value: { kind: "path" } }] },
    ],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

export const restoreCommand = {
  summary:
    "Replace the database with the one in a backup file, such as one saved by `zinn backup` or by an upgrade, after confirmation.",
  effects: { domain: "replace", storage: "restore" },
  confirmation: { kind: "prompt", description: confirmationDescription },
  input: restoreInputs.command,
  results: [jsonResult("Restore")],
  run: async (args) => {
    const { positionals, values, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: restoreInputs.command.options,
    });
    validateUniqueOptions(tokens, restoreInputs.command.options);
    validatePositionals(positionals, restoreInputs.command.forms[0]);

    const path = resolve(positionals[0]!);
    const { databasePath, backupDirectory } = getStorage();
    const isPreconfirmed = values.yes === true;

    // A backup that would be refused is refused before the prompt.
    if (!isPreconfirmed) {
      backup.check({ ...build, path });
    }

    const isConfirmed = await askConfirmation(
      `Replace the database at ${databasePath} with the backup ${path}? The current database is saved to ${backupDirectory} first.`,
      isPreconfirmed,
    );

    if (!isConfirmed) {
      output(null, () => `Restore cancelled. The database at ${databasePath} is unchanged`);
      return;
    }

    try {
      const result: PresentedRestore = backup.restore({ ...build, path, onWait: reportLockWait });

      output(result, (r) => {
        const restored = `Restored the database from ${path} at schema version ${r.restoredVersion}.`;
        return r.backupPath == null
          ? `${restored} There was no database to save`
          : `${restored} The database it replaced was saved to ${r.backupPath}`;
      });
    } catch (error) {
      // A refusal attempted nothing, so only a failed restore points at the backups.
      if (!(error instanceof RestoreRefusedError)) {
        const isDamagedDatabase =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code.startsWith("SQLITE_CORRUPT");

        if (isDamagedDatabase) {
          diagnostic(
            `The database at ${databasePath} is damaged. Nothing was changed. To restore it:\n` +
              `1. Close every program that has the database open.\n` +
              `2. Move ${databasePath}, ${databasePath}-wal and ${databasePath}-shm out of the data folder, keeping any that exist together. Keep these files; do not delete them.\n` +
              `3. Run the same zinn restore command again to create the database from the backup.`,
          );
        } else {
          diagnostic(
            `The database is unchanged. Backups taken before each restore attempt are kept in ${backupDirectory}.`,
          );
        }
      }

      throw error;
    }
  },
  help: `${generateCommandUsage("restore", restoreInputs.command)}

Replace the database with the one in a backup file, such as one saved by \`zinn backup\` or by an upgrade, after confirmation.

The current database is saved first, in the same place as \`zinn backup\`, and the restore is applied completely or not at all.
A backup with an older schema version is restored at that version. Zinn then upgrades it like any older database: by itself, except for ~/.zinn run from a source checkout, which needs \`zinn migrate\`.
Restoring onto a missing database creates it.
Fails, leaving the database as it is, when the backup has a newer schema version than this Zinn or none at all, is damaged, or is not a Zinn database.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn restore ~/.zinn/backups/2026-10-06T12-30-05Z-cli-0.40.0-1a2b3c4d.sqlite`,
} satisfies Command;
