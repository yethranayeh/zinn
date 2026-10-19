import { z } from "zod";

import { fullTextOrPartialEdit } from "./text-edit.js";
import { normalizeTextLineEndings, validateTextSize } from "./text.js";

const commentTextMessage = "Comment text cannot be blank";

export const commentTextSchema = z
  .string({ error: commentTextMessage })
  .superRefine(validateTextSize)
  .refine((value) => value.trim().length > 0, commentTextMessage)
  .transform(normalizeTextLineEndings);

export const commentCreateSchema = z.strictObject({
  taskKey: z.string(),
  text: commentTextSchema,
});

export const commentEditSchema = z.strictObject({
  commentKey: z.string(),
  text: fullTextOrPartialEdit(commentTextSchema),
});

export const commentDeleteSchema = z.strictObject({ commentKey: z.string() });

export type CommentCreateInput = z.infer<typeof commentCreateSchema>;
export type CommentEditInput = z.infer<typeof commentEditSchema>;
export type CommentDeleteInput = z.infer<typeof commentDeleteSchema>;
