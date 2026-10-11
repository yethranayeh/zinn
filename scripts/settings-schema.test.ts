import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SETTINGS_VERSION } from "../packages/core/src/schemas/settings.ts";
import {
  generateSettingsSchema,
  LATEST_FILE_NAME,
  SCHEMA_DIRECTORY,
  schemaFileName,
} from "./settings-schema.ts";

const PUBLISH_HINT = "the settings schema changed: run `bun run settings-schema`";

function readPublished(fileName: string) {
  return readFileSync(join(SCHEMA_DIRECTORY, fileName), "utf8");
}

/** The paths of every property in a JSON Schema that has no description, such as "storage.directory". */
function findUndescribedProperties(schema: Record<string, unknown>, prefix = ""): string[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  return Object.entries(properties).flatMap(([name, property]) => {
    const path = `${prefix}${name}`;
    const nested = findUndescribedProperties(property, `${path}.`);
    return typeof property.description === "string" ? nested : [path, ...nested];
  });
}

test("the published schema for SETTINGS_VERSION matches the settings schema (ZINN-58)", () => {
  expect(generateSettingsSchema(), PUBLISH_HINT).toBe(
    readPublished(schemaFileName(SETTINGS_VERSION)),
  );
});

test("latest.json is the schema for SETTINGS_VERSION, the highest published number (ZINN-58)", () => {
  expect(readPublished(LATEST_FILE_NAME)).toBe(readPublished(schemaFileName(SETTINGS_VERSION)));
  expect(existsSync(join(SCHEMA_DIRECTORY, schemaFileName(SETTINGS_VERSION + 1)))).toBe(false);
});

test("every setting has a description (ZINN-58)", () => {
  expect(findUndescribedProperties(JSON.parse(generateSettingsSchema()))).toEqual([]);
});
