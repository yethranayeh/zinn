/**
 * Publishes the settings JSON Schema to docs/public/schemas/settings/: `bun run settings-schema`
 * When the generated schema differs from v<N>.json for core's SETTINGS_VERSION, it writes
 * v<N+1>.json and latest.json and sets SETTINGS_VERSION to N+1. It never changes a published file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS_VERSION, settingsSchema } from "../packages/core/src/schemas/settings.ts";

export const SCHEMA_DIRECTORY = fileURLToPath(
  new URL("../docs/public/schemas/settings/", import.meta.url),
);
export const LATEST_FILE_NAME = "latest.json";
const SETTINGS_SOURCE = fileURLToPath(
  new URL("../packages/core/src/schemas/settings.ts", import.meta.url),
);

export function schemaFileName(version: number) {
  return `v${version}.json`;
}

/** The settings JSON Schema as published: draft-07, tab-indented, with a final newline. */
export function generateSettingsSchema() {
  return `${JSON.stringify(settingsSchema.toJSONSchema({ target: "draft-07" }), null, "\t")}\n`;
}

/** Writes v<version>.json and latest.json, refusing to replace a published number. */
function publish(version: number, schema: string) {
  const path = join(SCHEMA_DIRECTORY, schemaFileName(version));
  if (existsSync(path)) {
    throw new Error(
      `${path} is already published and is never changed. Check SETTINGS_VERSION in ${SETTINGS_SOURCE}.`,
    );
  }

  mkdirSync(SCHEMA_DIRECTORY, { recursive: true });
  writeFileSync(path, schema);
  writeFileSync(join(SCHEMA_DIRECTORY, LATEST_FILE_NAME), schema);
}

function main() {
  const schema = generateSettingsSchema();
  const currentPath = join(SCHEMA_DIRECTORY, schemaFileName(SETTINGS_VERSION));

  if (!existsSync(currentPath)) {
    publish(SETTINGS_VERSION, schema);
    console.log(`Wrote ${schemaFileName(SETTINGS_VERSION)} and ${LATEST_FILE_NAME}.`);
    return;
  }

  if (readFileSync(currentPath, "utf8") === schema) {
    console.log(`Settings schema ${schemaFileName(SETTINGS_VERSION)} is up to date.`);
    return;
  }

  const nextVersion = SETTINGS_VERSION + 1;
  const versionLine = `export const SETTINGS_VERSION = ${SETTINGS_VERSION};`;
  const source = readFileSync(SETTINGS_SOURCE, "utf8");
  const isSingleVersionLine = source.split(versionLine).length === 2;
  if (!isSingleVersionLine) {
    throw new Error(`Expected one line \`${versionLine}\` in ${SETTINGS_SOURCE}.`);
  }

  publish(nextVersion, schema);
  writeFileSync(
    SETTINGS_SOURCE,
    source.replace(versionLine, `export const SETTINGS_VERSION = ${nextVersion};`),
  );
  console.log(
    `Wrote ${schemaFileName(nextVersion)} and ${LATEST_FILE_NAME}, and set SETTINGS_VERSION to ${nextVersion}.`,
  );
}

if (import.meta.main) {
  main();
}
