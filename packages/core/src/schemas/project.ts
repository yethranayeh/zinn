import { z } from "zod";
import { descriptionSchema } from "./description";

const nameMessage = "Project name cannot be blank or contain line breaks or control characters";
export const invalidNameCharRegex = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export const projectNameSchema = z
  .string({ error: nameMessage })
  .refine((value) => value.trim().length > 0 && !invalidNameCharRegex.test(value), nameMessage);

export const projectKeyPattern = "[A-Za-z][A-Za-z0-9]*";

export const projectCreateSchema = z.strictObject({
  key: z
    .string()
    .regex(
      new RegExp(`^${projectKeyPattern}$`),
      "Project key must start with a letter and contain only letters and numbers",
    ),
  name: projectNameSchema.optional(),
  description: descriptionSchema.default(null),
});

export const projectEditSchema = z
  .strictObject({
    projectKey: z.string(),
    name: projectNameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    "Provide at least one field to edit: name or description",
  );

export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export type ProjectEditInput = z.infer<typeof projectEditSchema>;

export function validateProjectInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("\n"));
  }

  return result.data;
}
