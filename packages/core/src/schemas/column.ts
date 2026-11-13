import { z } from "zod";

import { titleTextSchema } from "./title-text.js";

export const columnNameSchema = titleTextSchema(
  "Column name cannot be blank",
  "Column name cannot contain line breaks or control characters",
);
/** What a column means to Zinn, independent of its name and position. Done and cancelled columns hold closed tasks. */
export const columnCategorySchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
/** Categories whose tasks are closed because they are either finished or won't be pursued */
export const CLOSED_COLUMN_CATEGORIES = ["done", "cancelled"] as const satisfies ReadonlyArray<
  z.infer<typeof columnCategorySchema>
>;
/** Categories that hold tasks that are ready to start in `task next` ordering */
export const READY_COLUMN_CATEGORIES = ["todo", "backlog"] as const satisfies ReadonlyArray<
  z.infer<typeof columnCategorySchema>
>;
export const columnCreateSchema = z.strictObject({
  projectKey: z.string(),
  name: columnNameSchema,
  category: columnCategorySchema,
});
export const columnEditSchema = z
  .strictObject({
    projectKey: z.string(),
    columnName: columnNameSchema,
    name: columnNameSchema.optional(),
    category: columnCategorySchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.category !== undefined,
    "Provide at least one field to edit: name or category",
  );
export const columnDeleteSchema = z.strictObject({
  projectKey: z.string(),
  columnName: columnNameSchema,
});
export const columnOrderSchema = z.discriminatedUnion("direction", [
  z.strictObject({
    projectKey: z.string(),
    columnName: columnNameSchema,
    direction: z.enum(["first", "previous", "next", "last"]),
  }),
  z.strictObject({
    projectKey: z.string(),
    columnName: columnNameSchema,
    direction: z.enum(["before", "after"]),
    targetColumnName: columnNameSchema,
  }),
]);
export type ColumnCategory = z.infer<typeof columnCategorySchema>;
export type ColumnCreateInput = z.infer<typeof columnCreateSchema>;
export type ColumnEditInput = z.infer<typeof columnEditSchema>;
export type ColumnDeleteInput = z.infer<typeof columnDeleteSchema>;
export type ColumnOrderInput = z.infer<typeof columnOrderSchema>;

export const columnInspectionSchema = z.strictObject({
  taskKeys: z.array(z.string()).default([]),
});
export type ColumnInspectionInput = z.input<typeof columnInspectionSchema>;
