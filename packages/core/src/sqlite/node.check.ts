// Run with `bun run test:node`: Bun cannot load node:sqlite, so this file is not a bun test.
import { test } from "node:test";

import * as adapter from "./node.ts";
import { defineContractChecks } from "./contract.ts";

defineContractChecks(test, adapter);
