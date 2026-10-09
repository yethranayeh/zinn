import { z } from "zod";

const invalidNameCharRegex = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function titleTextSchema(blankMessage: string, invalidCharacterMessage: string) {
  return z
    .string({ error: blankMessage })
    .refine((value) => value.trim().length > 0, blankMessage)
    .refine((value) => !invalidNameCharRegex.test(value), invalidCharacterMessage)
    .transform((value) => value.trim());
}
