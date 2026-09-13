import { expect, test } from "bun:test";
import { validateTaskInput, taskEditSchema, taskCreateSchema } from "./task";

test("edit schemas retain explicit values and never default omitted fields", () => {
  expect(taskEditSchema.parse({ taskKey: "TEST-1", description: "" })).toEqual({
    taskKey: "TEST-1", description: "",
  });
  expect(taskEditSchema.parse({ taskKey: "TEST-1", title: " Title " })).toEqual({
    taskKey: "TEST-1", title: " Title ",
  });
  expect(taskEditSchema.parse({ taskKey: "TEST-1", description: null }).description).toBeNull();
});

test("edit input validation rejects empty, mistyped, and unsupported changes", () => {
  for (const input of [
    { taskKey: "TEST-1" },
    { taskKey: "TEST-1", title: undefined },
    { taskKey: "TEST-1", title: 42 },
    { taskKey: "TEST-1", title: "Valid", column_id: "other" },
  ]) {
    expect(() => validateTaskInput(taskEditSchema, input)).toThrow();
  }
});

test("creation and editing share content validation", () => {
  for (const title of ["", " "]) {
    expect(taskCreateSchema.safeParse({ project_id: "id", title, description: null }).success).toBe(false);
    expect(taskEditSchema.safeParse({ taskKey: "TEST-1", title }).success).toBe(false);
  }
  expect(taskCreateSchema.parse({ project_id: "id", title: "Valid", description: "" }).description).toBe("");
});
