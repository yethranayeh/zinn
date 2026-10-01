import { expect, test } from "bun:test";
import { projectCreateSchema, projectEditSchema, validateProjectInput } from "./project";

test("project creation accepts an omitted name but rejects null", () => {
  expect(projectCreateSchema.parse({ key: "test" })).toEqual({ key: "test" });
  expect(projectCreateSchema.safeParse({ key: "TEST", name: null }).success).toBe(false);
});

test("project creation and editing share name validation and preserve supplied text", () => {
  for (const name of ["", " ", "Two\nlines", "Bad\u0000name"]) {
    expect(projectCreateSchema.safeParse({ key: "TEST", name }).success).toBe(false);
    expect(projectEditSchema.safeParse({ projectKey: "TEST", name }).success).toBe(false);
  }
  expect(projectEditSchema.parse({ projectKey: "test", name: " Name " })).toEqual({
    projectKey: "test", name: " Name ",
  });
});

test("project edits require a field and reject unsupported fields", () => {
  for (const input of [
    { projectKey: "TEST" },
    { projectKey: "TEST", name: undefined },
    { projectKey: "TEST", name: null },
    { projectKey: "TEST", name: 42 },
    { projectKey: "TEST", name: "Name", key: "NEW" },
  ]) {
    expect(() => validateProjectInput(projectEditSchema, input)).toThrow();
  }
});


test("project descriptions accept multiline text, null and empty strings", () => {
  for (const description of ["Line one\nLine two", "", null]) {
    expect(projectCreateSchema.parse({ key: "APP", description }).description).toBe(description);
    expect(projectEditSchema.parse({ projectKey: "APP", description }).description).toBe(description);
  }
  expect(projectEditSchema.safeParse({ projectKey: "APP", description: 42 }).success).toBe(false);
});
