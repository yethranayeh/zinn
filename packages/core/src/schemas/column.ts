import { z } from "zod";

import { invalidNameCharRegex } from "./project";

export const columnNameSchema = z
  .string()
  .trim()
  .min(1, "Column name cannot be blank")
  .refine(
    (value) => !invalidNameCharRegex.test(value),
    "Column name must contain printable text on a single line",
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
