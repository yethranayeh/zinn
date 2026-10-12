import type { Command } from "../types.js";

import { parseArgs } from "node:util";
import { backup } from "@zinn-dev/core";

import { output, validatePositionals } from "../lib.js";
import packageJson from "../../package.json" with { type: "json" };

export const backupCommand = {
  run: (args) => {
    const { positionals } = parseArgs({ args, strict: true, allowPositionals: true });
    validatePositionals(positionals, []);

    const created = backup.create({ client: "cli", version: packageJson.version });

    output(created, (b) => `Saved a backup to ${b.path}`);
  },
  help: `Usage: zinn backup

Save a copy of the database to ~/.zinn/backups/, or to backups/ in ZINN_DIR when it is set.

The copy includes recent writes and is safe to take while Zinn is in use.
Fails when there is no database yet. Existing backups are never overwritten.`,
} satisfies Command;
