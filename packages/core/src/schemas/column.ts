import { z } from "zod";

import { titleTextSchema } from "./title-text";

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
export type ColumnOrderInput = z.infer<typeof columnOrderSchema>;
