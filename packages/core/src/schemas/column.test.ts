import { expect, test } from "bun:test";

import {
  columnCategorySchema,
  columnCreateSchema,
  columnDeleteSchema,
  columnEditSchema,
  columnOrderSchema,
} from "./column";

test("column deletion requires a project and a trimmed column name", () => {
  expect(columnDeleteSchema.parse({ projectKey: "app", columnName: " Done " })).toEqual({
    projectKey: "app", columnName: "Done",
  });
  for (const input of [
    { projectKey: "APP" }, { columnName: "Done" },
    { projectKey: "APP", columnName: " " }, { projectKey: "APP", columnName: "In\nProgress" },
    { projectKey: "APP", columnName: "Done", name: "Later" },
  ]) {
    expect(columnDeleteSchema.safeParse(input).success).toBe(false);
  }
});

test("column names are trimmed and reject blank text, line breaks and control characters", () => {
  expect(columnCreateSchema.parse({ projectKey: "app", name: " Next ", category: "todo" })).toEqual({
    projectKey: "app",
    name: "Next",
    category: "todo",
  });

  for (const name of ["", "   ", "Next\nDone", "Next\tup", 42]) {
    expect(columnCreateSchema.safeParse({ projectKey: "app", name, category: "todo" }).success).toBe(false);
  }
});

test("column edits require a valid name and trim both names", () => {
  expect(columnEditSchema.parse({ projectKey: "app", columnName: " todo ", name: " Next " })).toEqual({
    projectKey: "app",
    columnName: "todo",
    name: "Next",
  });

  for (const input of [
    { projectKey: "app", columnName: "todo" },
    { projectKey: "app", columnName: "todo", name: "" },
    { projectKey: "app", columnName: "todo", name: "   " },
    { projectKey: "app", columnName: "todo", name: 42 },
    { projectKey: "app", columnName: "todo", name: "Next\nDone" },
    { projectKey: "app", columnName: " ", name: "Next" },
    { projectKey: "app", columnName: "todo", name: "Next", order: "a0" },
  ]) {
    expect(columnEditSchema.safeParse(input).success).toBe(false);
  }
});

test("column creation requires a category from the vocabulary", () => {
  for (const category of columnCategorySchema.options) {
    expect(columnCreateSchema.safeParse({ projectKey: "app", name: "Next", category }).success).toBe(true);
  }

  for (const category of [undefined, "Done", "canceled", "in progress", ""]) {
    expect(columnCreateSchema.safeParse({ projectKey: "app", name: "Next", category }).success).toBe(false);
  }
});

test("column edits take a name, a category or both", () => {
  expect(columnEditSchema.parse({ projectKey: "app", columnName: "todo", category: "done" })).toEqual({
    projectKey: "app",
    columnName: "todo",
    category: "done",
  });
  expect(
    columnEditSchema.safeParse({ projectKey: "app", columnName: "todo", name: "Next", category: "review" }).success,
  ).toBe(true);
  expect(columnEditSchema.safeParse({ projectKey: "app", columnName: "todo", category: "finished" }).success).toBe(false);
});

test("column orders take a target only for before and after", () => {
  expect(columnOrderSchema.parse({ projectKey: "app", columnName: " todo ", direction: "first" })).toEqual({
    projectKey: "app",
    columnName: "todo",
    direction: "first",
  });
  expect(
    columnOrderSchema.parse({ projectKey: "app", columnName: "todo", direction: "after", targetColumnName: " done " }),
  ).toEqual({ projectKey: "app", columnName: "todo", direction: "after", targetColumnName: "done" });

  for (const input of [
    { projectKey: "app", columnName: "todo" },
    { projectKey: "app", columnName: "todo", direction: "sideways" },
    { projectKey: "app", columnName: "todo", direction: "top" },
    { projectKey: "app", columnName: "todo", direction: "before" },
    { projectKey: "app", columnName: "todo", direction: "first", targetColumnName: "done" },
    { projectKey: "app", columnName: " ", direction: "previous" },
    { projectKey: "app", columnName: "todo", direction: "after", targetColumnName: " " },
  ]) {
    expect(columnOrderSchema.safeParse(input).success).toBe(false);
  }
});
