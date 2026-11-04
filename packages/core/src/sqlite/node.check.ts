// Run with `bun run test:node`: Bun cannot load node:sqlite, so this file is not a bun test.
import { test } from "node:test";
import { registerHooks } from "node:module";

import * as adapter from "./node.ts";
import { defineContractChecks } from "./contract.ts";

defineContractChecks(test, adapter);

// Native Node loads the source graph through its emitted .js import spellings
const sourceDirectory = new URL("../", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const isCoreSourceImport =
      context.parentURL?.startsWith(sourceDirectory) &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      new URL(specifier, context.parentURL).href.startsWith(sourceDirectory);
    return nextResolve(isCoreSourceImport ? specifier.slice(0, -3) + ".ts" : specifier, context);
  },
});
const { defineSchemaPinChecks } = await import("../../testing/schema-pins.ts");
defineSchemaPinChecks(test, adapter);
