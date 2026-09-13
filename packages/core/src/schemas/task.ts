import { z } from "zod";

const titleMessage = "Task title cannot be blank";

export const taskTitleSchema = z
  .string({ error: titleMessage })
  .refine((value) => value.trim().length > 0, titleMessage);

export const taskDescriptionSchema = z.string().nullable();

export const taskCreateSchema = z.strictObject({
  project_id: z.string(),
  title: taskTitleSchema,
  description: taskDescriptionSchema,
});

export const taskEditSchema = z
  .strictObject({
    taskKey: z.string(),
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.description !== undefined,
    "Provide at least one field to edit: title or description",
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
