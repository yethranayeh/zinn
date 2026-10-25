import { z } from "zod";

import { titleTextSchema } from "./title-text.js";

export const columnNameSchema = titleTextSchema(
  "Column name cannot be blank",
  "Column name cannot contain line breaks or control characters",
);
export const columnCreateSchema = z.strictObject({
  projectKey: z.string(),
  name: columnNameSchema,
});
export const columnEditSchema = z.strictObject({
  projectKey: z.string(),
  columnName: columnNameSchema,
  name: columnNameSchema,
});
export const columnDeleteSchema = columnEditSchema.omit({ name: true });
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
export type ColumnCreateInput = z.infer<typeof columnCreateSchema>;
export type ColumnEditInput = z.infer<typeof columnEditSchema>;
export type ColumnDeleteInput = z.infer<typeof columnDeleteSchema>;
export type ColumnOrderInput = z.infer<typeof columnOrderSchema>;

export const columnInspectionSchema = z.strictObject({
  taskKeys: z.array(z.string()).default([]),
  allowsLegacyRead: z.boolean().default(false),
});
export type ColumnInspectionInput = z.input<typeof columnInspectionSchema>;
