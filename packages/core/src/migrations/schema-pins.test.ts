import { test } from "bun:test";

import * as adapter from "../sqlite/bun.ts";
import { defineSchemaPinChecks } from "../../testing/schema-pins.ts";

defineSchemaPinChecks(test, adapter);
