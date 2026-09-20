import { z } from "zod";

export const labelNameSchema = z.string().trim().min(1, "Label name cannot be blank");
export const labelColorSchema = z.enum([
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
]);
export const labelCreateSchema = z.strictObject({
  name: labelNameSchema,
  description: z.string().optional(),
  color: labelColorSchema.optional(),
});
export const labelDeleteSchema = z.strictObject({ name: labelNameSchema });
export const taskLabelSchema = z.strictObject({
  taskKey: z.string(),
  labelNames: z.array(labelNameSchema).min(1, "Provide at least one label"),
});
export type LabelColor = z.infer<typeof labelColorSchema>;
export type LabelCreateInput = z.infer<typeof labelCreateSchema>;
export type LabelDeleteInput = z.infer<typeof labelDeleteSchema>;
export type TaskLabelInput = z.infer<typeof taskLabelSchema>;
