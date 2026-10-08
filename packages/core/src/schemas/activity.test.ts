import { expect, test } from "bun:test";
import { activityIdSchema, activityListSchema, activityTaskKeySchema } from "./activity";

test("activity IDs normalize full, compact and canonical left-prefix spellings", () => {
  const id = "019ABCDF-1234-7000-8000-123456ABCDEF";
  const hex = id.replaceAll("-", "").toLowerCase();
  for (const input of [id, id.toLowerCase(), hex]) {
    expect(activityIdSchema.parse(input)).toBe(hex);
  }
  for (const input of ["019ABCDF", "019ABCDF-", "019ABCDF-12", "019ABCDF1234", "019ABCDF-1234-7"]) {
    expect(activityIdSchema.parse(input)).toBe(input.replaceAll("-", "").toLowerCase());
  }
});

test("activity IDs distinguish too-short prefixes from malformed spelling", () => {
  for (const input of ["a", "019abcd"]) {
    expect(() => activityIdSchema.parse(input)).toThrow("at least 8 hexadecimal digits");
  }
  for (const input of ["", "019abcdg", "019a-bcdf", "019abcdf--1234", "019abcdf-12-7", "019abcdf_1234", "a".repeat(33), " 019abcdf"]) {
    expect(() => activityIdSchema.parse(input)).toThrow("Invalid activity ID");
  }
});

test("activity task keys share readable-key parsing and normalize project casing", () => {
  expect(activityTaskKeySchema.parse("app9-12")).toBe("APP9-12");
  for (const input of ["APP-0", "APP-01", "APP", "9APP-1", " APP-1", "APP-1 "]) {
    expect(() => activityTaskKeySchema.parse(input)).toThrow("Expected format PROJECT-1");
  }
});

test("activity lists accept optional filters and positive safe-integer limits", () => {
  expect(activityListSchema.parse({})).toEqual({});
  expect(activityListSchema.parse({ taskKey: "app-1", limit: Number.MAX_SAFE_INTEGER }))
    .toEqual({ taskKey: "APP-1", limit: Number.MAX_SAFE_INTEGER });
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
    expect(() => activityListSchema.parse({ limit })).toThrow("Activity limit must be a positive safe integer");
  }
  expect(activityListSchema.safeParse({ projectKey: "APP" }).success).toBe(false);
});
