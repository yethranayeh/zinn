import { expect, test } from "bun:test";

import { columnCreateSchema, columnEditSchema } from "./column";

test("column names are trimmed and must be printable text on a single line", () => {
  expect(columnCreateSchema.parse({ projectKey: "app", name: " Next " })).toEqual({
    projectKey: "app",
    name: "Next",
  });

  for (const name of ["", "   ", "Next\nDone", "Next\tup", 42]) {
    expect(columnCreateSchema.safeParse({ projectKey: "app", name }).success).toBe(false);
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
