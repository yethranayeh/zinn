import { z } from "zod";

const textEditMessage =
  "A text edit takes either { append } or { find, replace, all? }, and no other fields";

/** One change to existing text: add a paragraph at the end, or replace exact matches. */
export const textEditSchema = z.union(
  [
    z.strictObject({
      append: z
        .string()
        .refine((value) => value.trim().length > 0, "Text to append cannot be blank"),
    }),
    z.strictObject({
      find: z.string().min(1, "Text to find cannot be empty"),
      replace: z.string(),
      all: z.boolean().optional(),
    }),
  ],
  { error: textEditMessage },
);

/**
 * A text field that takes either the full text or one edit object.
 * A non-object value reports the error of the full-text schema.
 */
export function fullTextOrPartialEdit<S extends z.ZodType>(fullTextSchema: S) {
  return z.union([fullTextSchema, textEditSchema], {
    error: (issue) => {
      const isEditAttempt = typeof issue.input === "object" && issue.input !== null;
      return isEditAttempt ? textEditMessage : issue.errors[0]?.[0]?.message;
    },
  });
}

export type TextEdit = z.infer<typeof textEditSchema>;
