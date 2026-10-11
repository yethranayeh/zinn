import { z } from "zod";

/**
 * The settings version this schema implements, published at https://zinn.sh/schemas/settings/v<N>.json.
 * After changing the schema, run `bun run settings-schema`.
 * Raise the number first only for a breaking change:
 *  one that makes a valid file rejected or read differently, such as a removed or renamed setting.
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
