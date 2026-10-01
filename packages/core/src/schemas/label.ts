import { z } from "zod";
import { descriptionSchema } from "./description";

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
  description: descriptionSchema.default(null),
  color: labelColorSchema.optional(),
});
export const labelEditSchema = z
  .strictObject({
    labelName: labelNameSchema,
    name: labelNameSchema.optional(),
    description: descriptionSchema.optional(),
    color: labelColorSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.color !== undefined,
    "Provide at least one field to edit: name, description, or color",
  );
export const labelDeleteSchema = z.strictObject({ name: labelNameSchema });
export const taskLabelSchema = z.strictObject({
  taskKey: z.string(),
  labelNames: z.array(labelNameSchema).min(1, "Provide at least one label"),
});
export type LabelColor = z.infer<typeof labelColorSchema>;
export type LabelCreateInput = z.input<typeof labelCreateSchema>;
export type LabelEditInput = z.infer<typeof labelEditSchema>;
export type LabelDeleteInput = z.infer<typeof labelDeleteSchema>;
export type TaskLabelInput = z.infer<typeof taskLabelSchema>;
