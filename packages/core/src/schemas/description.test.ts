import { expect, test } from "bun:test";

import { projectCreateSchema, projectEditSchema } from "./project";
import { taskCreateSchema, taskEditSchema } from "./task";
import { labelCreateSchema, labelEditSchema } from "./label";

test("all description inputs share normalization, defaults and partial-edit semantics", () => {
  const entities = [
    {
      create: projectCreateSchema,
      createInput: { key: "APP" },
      edit: projectEditSchema,
      editInput: { projectKey: "APP", name: "App" },
    },
    {
      create: taskCreateSchema,
      createInput: { project_id: "id", title: "Task" },
      edit: taskEditSchema,
      editInput: { taskKey: "APP-1", title: "Task" },
    },
    {
      create: labelCreateSchema,
      createInput: { name: "bug" },
      edit: labelEditSchema,
      editInput: { labelName: "bug", color: "red" },
    },
  ];

  for (const entity of entities) {
    expect(entity.create.parse(entity.createInput).description).toBeNull();
    expect(entity.edit.parse(entity.editInput).description).toBeUndefined();

    for (const description of ["", null, " ", "\t", "\n", " \r\n\t "]) {
      expect(entity.create.parse({ ...entity.createInput, description }).description).toBeNull();
      expect(entity.edit.parse({ ...entity.editInput, description }).description).toBeNull();
    }

    for (const description of ["Context", "  Context\nMore text  ", "    First\n    Second\n"]) {
      expect(entity.create.parse({ ...entity.createInput, description }).description).toBe(description);
      expect(entity.edit.parse({ ...entity.editInput, description }).description).toBe(description);
    }

    expect(entity.create.safeParse({ ...entity.createInput, description: 42 }).success).toBe(false);
    expect(entity.edit.safeParse({ ...entity.editInput, description: 42 }).success).toBe(false);
  }
});
