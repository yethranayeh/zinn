import { z } from "zod";

import { labelNameSchema } from "./label";

const titleMessage = "Task title cannot be blank";

export const taskTitleSchema = z
  .string({ error: titleMessage })
  .refine((value) => value.trim().length > 0, titleMessage);

export const taskDescriptionSchema = z.string().nullable();

export const taskCreateSchema = z.strictObject({
  project_id: z.string(),
  title: taskTitleSchema,
  description: taskDescriptionSchema,
  labelNames: z.array(labelNameSchema).optional(),
});

export const taskEditSchema = z
  .strictObject({
    taskKey: z.string(),
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.optional(),
    addLabelNames: z.array(labelNameSchema).optional(),
    removeLabelNames: z.array(labelNameSchema).optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      (value.addLabelNames?.length ?? 0) > 0 ||
      (value.removeLabelNames?.length ?? 0) > 0,
    "Provide at least one field to edit: title, description, or labels",
  )
  .refine(
    (value) => !value.addLabelNames?.some((name) => value.removeLabelNames?.includes(name)),
    "Cannot add and remove the same label",
  );

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskEditInput = z.infer<typeof taskEditSchema>;

export function validateTaskInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("\n"));
  }

  return result.data;
}
