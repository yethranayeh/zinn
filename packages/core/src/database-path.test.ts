import { test } from "bun:test";

import { defineDatabasePathChecks } from "../testing/database-path.ts";

defineDatabasePathChecks(test);
