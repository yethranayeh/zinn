import type { Command } from "../types";

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { BACKUP_DIR, backup, DB_PATH, RestoreRefusedError } from "@zinn-dev/core";

import { reportLockWait } from "../database";
import { askConfirmation, output, validatePositionalCount, validateUniqueOptions } from "../lib";
import packageJson from "../../package.json";

const build = { client: "cli", version: packageJson.version };

export const restoreCommand = {
  run: (args) => {
    const { positionals, values, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: { yes: { type: "boolean" } },
    });
    validateUniqueOptions(tokens);
    validatePositionalCount(positionals, 1, "Specify the backup file to restore");

    const path = resolve(positionals[0]!);
    const isPreconfirmed = values.yes === true;

    // A backup that would be refused is refused before the prompt.
    if (!isPreconfirmed) {
      backup.check({ ...build, path });
    }

    const isConfirmed = askConfirmation(
      `Replace the database at ${DB_PATH} with the backup ${path}? Its current board is saved to ${BACKUP_DIR} first.`,
      isPreconfirmed,
    );

    if (!isConfirmed) {
      output(null, () => `Restore cancelled. The database at ${DB_PATH} is unchanged`);
      return;
    }

    try {
      const result = backup.restore({ ...build, path, onWait: reportLockWait });

      output(result, (r) => {
        const restored = `Restored the board from ${path} at schema version ${r.restoredVersion}.`;
        return r.backupPath == null
          ? `${restored} There was no board to save`
          : `${restored} The board it replaced was saved to ${r.backupPath}`;
      });
    } catch (error) {
      // A refusal attempted nothing, so only a failed restore points at the backups.
      if (!(error instanceof RestoreRefusedError)) {
        console.error(
          `The database is unchanged. Backups taken before each restore attempt are kept in ${BACKUP_DIR}.`,
        );
      }

      throw error;
    }
  },
  help: `Usage: zinn restore <path> [--yes]

Replace the board with the one in a backup file, such as one saved by \`zinn backup\` or by an upgrade, after confirmation.

The current board is saved first, in the same place as \`zinn backup\`, and the restore is applied completely or not at all.
A backup with an older schema version is restored at that version. Zinn then upgrades it like any older database: by itself, except for ~/.zinn run from a source checkout, which needs \`zinn migrate\`.
Restoring onto a missing database creates it.
Fails, leaving the database as it is, when the backup has a newer schema version than this Zinn or none at all, is damaged, or is not a Zinn database.
Use --yes to skip the confirmation prompt, for example in scripts or with --json.

Example: zinn restore ~/.zinn/backups/2026-10-06T12-30-05Z-cli-0.40.0-1a2b3c4d.sqlite`,
} satisfies Command;
