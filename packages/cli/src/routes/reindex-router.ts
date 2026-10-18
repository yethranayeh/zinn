import type { Command } from "../types.js";

import { parseArgs } from "node:util";
import { reindex } from "@zinn-dev/core";

import { reportLockWait } from "../database.js";
import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";

export const reindexCommand = {
  summary:
    "Rebuild the search index that `zinn task search` uses from the tasks and their comments, archived tasks included.",
  effects: { domain: "none", storage: "reindex" },
  confirmation: { kind: "none" },
  input: noInput,
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);

    const result = reindex.run({ onWait: reportLockWait });

    output(result, (r) => {
      const noun = r.taskCount === 1 ? "task" : "tasks";
      return `Rebuilt the search index from ${r.taskCount} ${noun}`;
    });
  },
  help: `${generateCommandUsage("reindex", noInput)}

Rebuild the search index that \`zinn task search\` uses from the tasks and their comments, archived tasks included.

Only the index changes, completely or not at all, so no backup is saved.
Fails, leaving the database as it is, when there is no database yet or when this Zinn cannot change it, such as a database with a newer schema version.`,
} satisfies Command;
