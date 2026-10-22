import { expect, test } from "bun:test";
import { settingsSchema } from "./settings";

test("settings accept an empty file, a $schema and a storage directory", () => {
  expect(settingsSchema.parse({})).toEqual({});
  expect(settingsSchema.parse({ $schema: "https://example.com/schema.json", storage: { directory: "store" } })).toEqual({
    $schema: "https://example.com/schema.json",
    storage: { directory: "store" },
  });
});

test("settings accept hooks with a command and an optional timeout in seconds", () => {
  const hooks = { notify: { command: "cat > /dev/null" }, slow: { command: "true", timeout: 0.5 } };
  expect(settingsSchema.parse({ hooks })).toEqual({ hooks });
});

test("settings reject unknown keys, a storage without a directory and wrong types", () => {
  for (const input of [
    { storge: { directory: "store" } },
    { storage: { directory: "store", path: "x" } },
    { storage: {} },
    { storage: null },
    { storage: { directory: 42 } },
    { $schema: 42 },
    { hooks: { notify: {} } },
    { hooks: { notify: { command: "" } } },
    { hooks: { notify: { command: "true", timeout: 0 } } },
    { hooks: { notify: { command: "true", event: "move" } } },
    { hooks: { "": { command: "true" } } },
    [],
    "text",
  ]) {
    expect(settingsSchema.safeParse(input).success).toBe(false);
  }
});
