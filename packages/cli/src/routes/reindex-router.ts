import type { Command } from "../types";

import { parseArgs } from "node:util";
import { reindex } from "@zinn-dev/core";

import { reportLockWait } from "../database";
import { output } from "../lib";

export const reindexCommand = {
  run: (args) => {
    parseArgs({ args, strict: true, allowPositionals: false });

    const result = reindex.run({ onWait: reportLockWait });

    output(result, (r) => {
      const noun = r.taskCount === 1 ? "task" : "tasks";
      return `Rebuilt the search index from ${r.taskCount} ${noun}`;
    });
  },
  help: `Usage: zinn reindex

Rebuild the search index that \`zinn task search\` uses from the tasks and their comments, archived tasks included.

Only the index changes, completely or not at all, so no backup is saved.
Fails, leaving the database as it is, when there is no database yet or when this Zinn cannot change it, such as a database with a newer schema version.`,
} satisfies Command;
