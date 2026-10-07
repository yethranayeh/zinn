import { z } from "zod";

/** The content of a settings file, global or per codebase. */
export const settingsSchema = z.strictObject({
  /** The address of the file's JSON Schema, for editors. Ignored when Zinn reads the file. */
  $schema: z.string().optional(),
  storage: z.strictObject({ directory: z.string() }).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;
