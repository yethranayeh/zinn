import type { Command } from "../types.js";

import { parseArgs } from "node:util";

import { generateCommandUsage, noInput } from "../input.js";
import { getOutputMode, output, validatePositionals } from "../lib.js";
import { formatCapabilities } from "../presentation/capabilities-presentation.js";
import { jsonResult } from "../results.js";

export const capabilitiesCommand = {
  summary: "Describe the installed CLI commands, inputs, results and errors.",
  effects: { domain: "none", storage: "none" },
  confirmation: { kind: "none" },
  input: noInput,
  results: [jsonResult("Capabilities")],
  run: async (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });

    validatePositionals(positionals, noInput.forms[0]);

    const { generateCapabilities, getCapabilitySummary } = await import("../capabilities.js");
    if (getOutputMode() === "json") {
      output(generateCapabilities(), () => formatCapabilities(getCapabilitySummary()));
    } else {
      output(getCapabilitySummary(), formatCapabilities);
    }
  },
  help: `${generateCommandUsage("capabilities", noInput)}

Describe the installed CLI commands, inputs, results and errors.

Experimental. Use --json for the full contract, including reusable JSON Schemas.
Discovery works without reading settings or opening storage.`,
} satisfies Command;
