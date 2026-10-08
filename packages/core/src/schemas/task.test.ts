import { expect, test } from "bun:test";
import { validateTaskInput, taskEditSchema, taskCreateSchema, taskListSchema } from "./task";

test("task list accepts a single column name without changing its matching input", () => {
  expect(taskListSchema.parse({ columnName: " In Progress " })).toEqual({ columnName: " In Progress " });
  expect(taskListSchema.parse({})).toEqual({});
  expect(taskListSchema.safeParse({ columnName: ["Review", "Done"] }).success).toBe(false);
});

test("edit schemas normalize empty descriptions and never default omitted fields", () => {
  expect(taskEditSchema.parse({ taskKey: "TEST-1", description: "" })).toEqual({
    taskKey: "TEST-1", description: null,
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
  expect(taskCreateSchema.parse({ project_id: "id", title: "Valid", description: "" }).description).toBeNull();
});

test("label edits reject empty requests and conflicting normalized names", () => {
  expect(taskEditSchema.safeParse({ taskKey: "TEST-1", addLabelNames: [] }).success).toBe(false);
  expect(taskEditSchema.safeParse({ taskKey: "TEST-1", addLabelNames: ["bug"], removeLabelNames: [" bug "] }).success).toBe(false);
  expect(taskEditSchema.safeParse({ taskKey: "TEST-1", addLabelNames: ["BUG"], removeLabelNames: ["bug"] }).success).toBe(false);
  expect(taskEditSchema.safeParse({ taskKey: "TEST-1", addLabelNames: [""] }).success).toBe(false);
  expect(taskEditSchema.parse({ taskKey: "TEST-1", addLabelNames: [" bug "] }).addLabelNames).toEqual(["bug"]);
});

test("priority accepts only fixed values or null and leaves omitted edits unset", () => {
  for (const priority of ["low", "medium", "high", "urgent", null] as const) {
    expect(taskCreateSchema.parse({ project_id: "id", title: "Task", description: null, priority }).priority).toBe(priority);
    expect(taskEditSchema.parse({ taskKey: "TEST-1", priority }).priority).toBe(priority);
  }
  for (const priority of ["none", "critical", "", 1]) {
    expect(taskCreateSchema.safeParse({ project_id: "id", title: "Task", description: null, priority }).success).toBe(false);
    expect(taskEditSchema.safeParse({ taskKey: "TEST-1", priority }).success).toBe(false);
  }
  expect(taskEditSchema.parse({ taskKey: "TEST-1", title: "Task" }).priority).toBeUndefined();
  expect(taskEditSchema.safeParse({ taskKey: "TEST-1", priority: undefined }).success).toBe(false);
});
