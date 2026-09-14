import { z } from "zod";

const nameMessage = "Project name must contain printable text on a single line";
const invalidNameCharRegex = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export const projectNameSchema = z
  .string({ error: nameMessage })
  .refine((value) => value.trim().length > 0 && !invalidNameCharRegex.test(value), nameMessage);

export const projectCreateSchema = z.strictObject({
  key: z
    .string()
    .regex(
      /^[A-Za-z][A-Za-z0-9]*$/,
      "Project key must start with a letter and contain only letters and numbers",
    ),
  name: projectNameSchema.optional(),
});

export const projectEditSchema = z.strictObject({
  projectKey: z.string(),
  name: projectNameSchema,
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectEditInput = z.infer<typeof projectEditSchema>;

export function validateProjectInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("\n"));
  }

  return result.data;
}
