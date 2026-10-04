import { test } from "bun:test";

import * as adapter from "./bun.ts";
import { defineContractChecks } from "./contract.ts";

defineContractChecks(test, adapter);
