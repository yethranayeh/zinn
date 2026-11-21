import { expect, test } from "bun:test";
import { DEFAULT_OPTIONS, readOptions } from "./options.ts";

test("claim renewal is on by default", () => {
  expect(DEFAULT_OPTIONS.renewClaims).toBe(true);
  expect(readOptions(undefined).renewClaims).toBe(true);
  expect(readOptions({}).renewClaims).toBe(true);
  expect(readOptions({ rows: 2, current: "glyph" }).renewClaims).toBe(true);
});
test("only an explicit false turns claim renewal off", () => {
  expect(readOptions({ renewClaims: false }).renewClaims).toBe(false);
  expect(readOptions({ renewClaims: "false" }).renewClaims).toBe(true);
  expect(readOptions({ renewClaims: 0 }).renewClaims).toBe(true);
  expect(readOptions({ renewClaims: null }).renewClaims).toBe(true);
});
test("claim renewal does not follow the current mark", () => {
  expect(readOptions({ current: "off" }).renewClaims).toBe(true);
  expect(readOptions({ current: "glyph", renewClaims: false }).renewClaims).toBe(false);
});
