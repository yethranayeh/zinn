import type { PresentedBackup } from "../result-schemas.js";
import type { Command } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { backup } from "@zinn-dev/core";

import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";
import packageJson from "../../package.json" with { type: "json" };

export const backupCommand = {
  summary:
    "Save a copy of the database to ~/.zinn/backups/, or to backups/ in ZINN_DIR when it is set.",
  effects: { domain: "none", storage: "backup" },
  confirmation: { kind: "none" },
  input: noInput,
  results: [jsonResult("Backup")],
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);

    const created: PresentedBackup = backup.create({ client: "cli", version: packageJson.version });

    output(created, (b) => `Saved a backup to ${b.path}`);
  },
  help: `${generateCommandUsage("backup", noInput)}

Save a copy of the database to ~/.zinn/backups/, or to backups/ in ZINN_DIR when it is set.

The copy includes recent writes and is safe to take while Zinn is in use.
Fails when there is no database yet. Existing backups are never overwritten.`,
} satisfies Command;
