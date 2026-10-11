import { z } from "zod";

/**
 * The settings version this schema implements, published at https://zinn.sh/schemas/settings/v<N>.json.
 * Any change to what the schema accepts needs the next number: run `bun run settings-schema`.
 */
export const SETTINGS_VERSION = 1;

/** The content of a settings file, global or per codebase. Descriptions show in editors through the published JSON Schema. */
export const settingsSchema = z
  .strictObject({
    $schema: z.string().optional().describe("The address of this file's JSON Schema, for editors."),
    storage: z
      .strictObject({
        directory: z
          .string()
          .describe(
            "The Zinn directory, which holds data/zinn.sqlite and backups/. A relative path is relative to the folder of this file, and a leading ~ means your home folder. ZINN_DIR, when set, takes precedence.",
          ),
      })
      .optional()
      .describe("Where Zinn keeps its data."),
  })
  .meta({ title: "Zinn settings" });

export type Settings = z.infer<typeof settingsSchema>;
