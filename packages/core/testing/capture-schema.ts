// Usage: bun packages/core/testing/capture-schema.ts
// Writes the schema this source creates to schema-snapshots/v<version>.json and never overwrites a snapshot.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { createSchema, readSchemaVersion } from "../src/migrations/runner";
import { applicationSchema } from "../src/migrations/testing";

const db = openDatabase(":memory:");

try {
  createSchema(db);
  const schemaVersion = readSchemaVersion(db);
  const output = join(import.meta.dir, "schema-snapshots", `v${schemaVersion}.json`);
  const snapshot = { schemaVersion, objects: applicationSchema(db) };
  writeFileSync(output, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  console.log(`Captured schema v${schemaVersion} at ${output}`);
} finally {
  db.close();
}
