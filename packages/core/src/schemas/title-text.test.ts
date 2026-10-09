import { expect, test } from "bun:test";
import { projectCreateSchema, projectEditSchema } from "./project";
import { columnCreateSchema, columnEditSchema, columnOrderSchema } from "./column";
import { labelCreateSchema, labelEditSchema, labelDeleteSchema } from "./label";
import { taskCreateSchema, taskEditSchema, taskListSchema } from "./task";

const titleInputs = [
  { schema: projectCreateSchema, input: { key: "APP" }, field: "name" },
  { schema: projectEditSchema, input: { projectKey: "APP" }, field: "name" },
  { schema: columnCreateSchema, input: { projectKey: "APP" }, field: "name" },
  { schema: columnEditSchema, input: { projectKey: "APP", columnName: "TODO" }, field: "name" },
  { schema: labelCreateSchema, input: {}, field: "name" },
  { schema: labelEditSchema, input: { labelName: "bug" }, field: "name" },
  { schema: taskCreateSchema, input: { project_id: "id" }, field: "title" },
  { schema: taskEditSchema, input: { taskKey: "APP-1" }, field: "title" },
];

test("names and titles share trimming, blank and single-line validation on create and edit", () => {
  for (const { schema, input, field } of titleInputs) {
    expect(schema.parse({ ...input, [field]: "  Café 🌿  next  " })).toHaveProperty(field, "Café 🌿  next");
    for (const value of ["", "   ", null, 42, "Line\nnext", "\nName", "Name\r\n", "\tName", "Name\t", "Na\u0000me", "Name\u007f", "Name\u0085", "Name\u2028", "Name\u2029"]) {
      expect(schema.safeParse({ ...input, [field]: value }).success).toBe(false);
    }
  }
});

test("name selectors follow the same rule", () => {
  const selectors = [
    { schema: columnEditSchema, input: { projectKey: "APP", name: "Next" }, field: "columnName" },
    { schema: columnOrderSchema, input: { projectKey: "APP", direction: "first" }, field: "columnName" },
    { schema: columnOrderSchema, input: { projectKey: "APP", columnName: "TODO", direction: "before" }, field: "targetColumnName" },
    { schema: labelEditSchema, input: { name: "Next" }, field: "labelName" },
    { schema: labelDeleteSchema, input: {}, field: "name" },
    { schema: taskCreateSchema, input: { project_id: "id", title: "Task" }, field: "columnName" },
    { schema: taskListSchema, input: {}, field: "columnName" },
  ];
  for (const { schema, input, field } of selectors) {
    expect(schema.parse({ ...input, [field]: " Next " })).toHaveProperty(field, "Next");
    for (const value of [" ", "Next\n", "\tNext"]) {
      expect(schema.safeParse({ ...input, [field]: value }).success).toBe(false);
    }
  }
});
