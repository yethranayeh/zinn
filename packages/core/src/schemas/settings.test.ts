import { expect, test } from "bun:test";
import { settingsSchema } from "./settings";

test("settings accept an empty file, a $schema and a storage directory", () => {
  expect(settingsSchema.parse({})).toEqual({});
  expect(settingsSchema.parse({ $schema: "https://example.com/schema.json", storage: { directory: "store" } })).toEqual({
    $schema: "https://example.com/schema.json",
    storage: { directory: "store" },
  });
});

test("settings reject unknown keys, a storage without a directory and wrong types", () => {
  for (const input of [
    { storge: { directory: "store" } },
    { storage: { directory: "store", path: "x" } },
    { storage: {} },
    { storage: null },
    { storage: { directory: 42 } },
    { $schema: 42 },
    [],
    "text",
  ]) {
    expect(settingsSchema.safeParse(input).success).toBe(false);
  }
});
