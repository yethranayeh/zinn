import type { Command } from "../types.js";

import { jsonResult } from "../results.js";
import { parseArgs } from "node:util";
import { info } from "@zinn-dev/core";

import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";
import { formatInfo, presentInfo } from "../presentation/info-presentation.js";

export const infoCommand = {
  summary:
    "Show the selected store, settings sources, telemetry state, database schema state and CLI, core and runtime versions.",
  effects: { domain: "none", storage: "inspect" },
  confirmation: { kind: "none" },
  input: noInput,
  results: [jsonResult("Info")],
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);
    output(presentInfo(info.get()), formatInfo);
  },
  help: `${generateCommandUsage("info", noInput)}

Show the selected store, settings sources, telemetry state, database schema state and CLI, core and runtime versions.

Reports unusable settings and database errors and exits successfully.
Telemetry is local (collected on this machine, never sent) or off. A telemetry.mode in a settings file overrides DO_NOT_TRACK=1 (https://donottrack.sh/). The telemetry folder is reported but never created.
SQLite may perform its normal file housekeeping when this command is triggered.`,
} satisfies Command;
