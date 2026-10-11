/**
 * Writes the settings JSON Schema to docs/public/schemas/settings/v<N>.json for core's
 *  `SETTINGS_VERSION` when its content changed: `bun run settings-schema`
 * Files of lower numbers are never written again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { SETTINGS_VERSION, settingsSchema } from "../packages/core/src/schemas/settings.ts";

export const SCHEMA_DIRECTORY = fileURLToPath(
  new URL("../docs/public/schemas/settings/", import.meta.url),
);

export function schemaFileName(version: number) {
  return `v${version}.json`;
}

/** The settings JSON Schema as published: draft-07, tab-indented, with a final newline. */
export function generateSettingsSchema() {
  return `${JSON.stringify(settingsSchema.toJSONSchema({ target: "draft-07" }), null, "\t")}\n`;
}

/** Whether two schema files hold the same JSON, whatever their formatting. */
export function isSameSchema(schema: string, otherSchema: string) {
  return isDeepStrictEqual(JSON.parse(schema), JSON.parse(otherSchema));
}

function main() {
  const schema = generateSettingsSchema();
  const fileName = schemaFileName(SETTINGS_VERSION);
  const path = join(SCHEMA_DIRECTORY, fileName);

  if (existsSync(path) && isSameSchema(readFileSync(path, "utf8"), schema)) {
    console.log(`Settings schema ${fileName} is up to date.`);
    return;
  }

  mkdirSync(SCHEMA_DIRECTORY, { recursive: true });
  writeFileSync(path, schema);
  console.log(`Wrote ${fileName}.`);
}

if (import.meta.main) {
  main();
}
