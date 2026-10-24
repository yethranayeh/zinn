import { expect, test } from "bun:test";
import type { ActivityListInput } from "./activity";
import { activityChangedFieldSchema, activityIdSchema, activityListSchema, activityTaskIdSchema, activityTaskKeySchema, activityIdentitySelectors } from "./activity";

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

test("activity IDs reject too-short prefixes and malformed spelling", () => {
  for (const input of ["a", "019abcd"]) {
    expect(activityIdSchema.safeParse(input).error?.issues).toMatchObject([{ code: "custom", path: [] }]);
  }
  for (const input of ["", "019abcdg", "019a-bcdf", "019abcdf--1234", "019abcdf-12-7", "019abcdf_1234", "a".repeat(33), " 019abcdf"]) {
    expect(activityIdSchema.safeParse(input).error?.issues).toMatchObject([{ code: "custom", path: [] }]);
  }
});

test("activity task keys share readable-key parsing and normalize project casing", () => {
  expect(activityTaskKeySchema.parse("app9-12")).toBe("APP9-12");
  for (const input of ["APP-0", "APP-01", "APP", "9APP-1", " APP-1", "APP-1 "]) {
    expect(activityTaskKeySchema.safeParse(input).error?.issues).toMatchObject([{ code: "custom", path: [] }]);
  }
});

test("activity lists accept optional filters and positive safe-integer limits", () => {
  expect(activityListSchema.parse({})).toEqual({});
  expect(activityListSchema.parse({ taskKey: "app-1", limit: Number.MAX_SAFE_INTEGER }))
    .toEqual({ taskKey: "APP-1", limit: Number.MAX_SAFE_INTEGER });
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
    expect(activityListSchema.safeParse({ limit }).error?.issues).toMatchObject([{ path: ["limit"] }]);
  }
  expect(activityListSchema.safeParse({ unknown: "APP" }).success).toBe(false);
});

test("task identity selectors normalize only full UUIDs and locate invalid inputs", () => {
  const id = "019abcdf-1234-7000-8000-123456abcdef";
  for (const input of [id, id.toUpperCase(), id.replaceAll("-", ""), id.replaceAll("-", "").toUpperCase()]) {
    expect(activityTaskIdSchema.parse(input)).toBe(id);
    expect(activityListSchema.parse({ taskId: input })).toEqual({ taskId: id });
  }
  for (const input of ["019abcdf", id.slice(0, -1), id + "0", "019a-bcdf123470008000123456abcdef", id + " ", "", null, 1]) {
    const result = activityListSchema.safeParse({ taskId: input });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["taskId"]);
    }
  }
});

test("deleted-history selection requires a key and excludes exact task IDs", () => {
  for (const showDeleted of [false, true]) {
    expect(activityListSchema.parse({ taskKey: "app-1", showDeleted }))
      .toEqual({ taskKey: "APP-1", showDeleted });
    expect(activityListSchema.safeParse({ showDeleted }).success).toBe(false);
    expect(activityListSchema.safeParse({ taskId: "019abcdf-1234-7000-8000-123456abcdef", showDeleted }).success).toBe(false);
  }
  expect(activityListSchema.safeParse({ taskKey: "APP-1", taskId: "019abcdf-1234-7000-8000-123456abcdef" }).success).toBe(false);
  for (const showDeleted of [null, "false", 0]) {
    expect(activityListSchema.safeParse({ taskKey: "APP-1", showDeleted }).success).toBe(false);
  }
});

test("session and thread filters preserve exact opaque values and reject empty or non-string inputs", () => {
  const input = { sessionId: " Conversation/1 ", threadId: "1", taskKey: "app-1", limit: 2 };
  expect(activityListSchema.parse(input)).toEqual({ ...input, taskKey: "APP-1" });
  for (const field of ["sessionId", "threadId"] as const) {
    for (const value of ["", null, 1, true, []]) {
      expect(activityListSchema.safeParse({ [field]: value }).success).toBe(false);
    }
  }
});

test("changed filters accept repeated named values and null only for priority", () => {
  const changed: NonNullable<ActivityListInput["changed"]> = [
    { field: "column", value: "Review" },
    { field: "column", value: "Done" },
    { field: "priority", value: null },
    { field: "priority", value: "HIGH" },
    { field: "labels", value: "needs=review" },
  ];
  expect(activityListSchema.parse({ changed })).toEqual({ changed });
  for (const changed of [null, "column=Review", [{}], [{ field: "column" }], [{ field: "column", value: "" }], [{ field: "labels", value: null }], [{ field: "column", value: null }], [{ field: "priority", value: 1 }], [{ field: "column", value: "Review", extra: true }]]) {
    expect(activityListSchema.safeParse({ changed }).success).toBe(false);
  }
  for (const field of ["title", "description", "comment", "unknown", "Column"]) {
    const result = activityListSchema.safeParse({ changed: [{ field, value: "value" }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["changed", 0, "field"]);
      for (const accepted of activityChangedFieldSchema.options) {
        expect(result.error.issues[0]?.message).toContain(accepted);
      }
    }
  }
});

test("project selectors share key and full UUID normalization and reject every selector pair", () => {
  const id = "019abcdf-1234-7000-8000-123456abcdef";
  expect(activityListSchema.parse({ projectKey: "app9" })).toEqual({ projectKey: "APP9" });
  for (const projectKey of ["", "9APP", "APP-1", " APP", "APP ", null]) {
    expect(activityListSchema.safeParse({ projectKey }).success).toBe(false);
  }
  for (const projectId of [id, id.toUpperCase(), id.replaceAll("-", ""), id.replaceAll("-", "").toUpperCase()]) {
    expect(activityListSchema.parse({ projectId })).toEqual({ projectId: id });
  }
  for (const projectId of ["019abcdf", id.slice(0, -1), id + "0", "019a-bcdf123470008000123456abcdef", "", null, 1]) {
    expect(activityListSchema.safeParse({ projectId }).success).toBe(false);
  }
  const values = { projectKey: "APP", projectId: id, taskKey: "APP-1", taskId: id };
  for (const [index, left] of activityIdentitySelectors.entries()) {
    for (const right of activityIdentitySelectors.slice(index + 1)) {
      expect(activityListSchema.safeParse({ [left]: values[left], [right]: values[right] }).success).toBe(false);
    }
  }
  for (const showDeleted of [false, true]) {
    expect(activityListSchema.parse({ projectKey: "app", showDeleted })).toEqual({ projectKey: "APP", showDeleted });
    expect(activityListSchema.safeParse({ projectId: id, showDeleted }).success).toBe(false);
  }
});
