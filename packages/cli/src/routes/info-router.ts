import type { Command } from "../types.js";
import { parseArgs } from "node:util";
import { info } from "@zinn-dev/core";
import { output, validatePositionals } from "../lib.js";
import { formatInfo, presentInfo } from "../presentation/info-presentation.js";

export const infoCommand = {
  run: (args) => {
    const { positionals } = parseArgs({ args, strict: true, allowPositionals: true });
    validatePositionals(positionals, []);
    output(presentInfo(info.get()), formatInfo);
  },
  help: `Usage: zinn info

Show the selected store, settings sources, database schema state and CLI, core and runtime versions.

Reports unusable settings and database errors and exits successfully.
SQLite may perform its normal file housekeeping when this command is triggered.`,
} satisfies Command;
