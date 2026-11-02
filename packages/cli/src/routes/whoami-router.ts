import type { Command } from "../types.js";

import { parseArgs } from "node:util";

import { currentActor } from "../actor.js";
import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";
import { formatActor, presentActor } from "../presentation/activity-presentation.js";
import { jsonResult } from "../results.js";

export const whoamiCommand = {
  summary: "Show the actor a change would record in the current environment and folder.",
  effects: { domain: "none", storage: "none" },
  confirmation: { kind: "none" },
  input: noInput,
  results: [jsonResult("Actor")],
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);
    output(presentActor(currentActor()), formatActor);
  },
  help: `${generateCommandUsage("whoami", noInput)}

Show the actor a change would record in the current environment and folder.
Includes name, email, kind, source, session, thread, agent, model, effort and client.
Git identity is read from the current folder.

Works without reading settings or opening storage.
Use --json for the actor_* fields carried by activity records.`,
} satisfies Command;
