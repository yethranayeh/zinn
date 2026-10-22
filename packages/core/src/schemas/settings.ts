import { z } from "zod";
import { projectCreateSchema } from "./project.js";

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
    defaultProject: projectCreateSchema.shape.key
      .optional()
      .describe(
        "The project key used to scope results to the specificed project board when no explicit key is given. Local setting overrides the global one. An explicitly given key in a command overrides both.",
      ),
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
    hooks: z
      .record(
        z.string().min(1),
        z
          .strictObject({
            command: z
              .string()
              .min(1)
              .describe(
                "The command to run through the platform shell after each saved change. It gets the change's activity records on stdin, one JSON object per line.",
              ),
            timeout: z
              .number()
              .positive()
              .optional()
              .describe(
                "Seconds the hook may run before it is stopped with a warning. Defaults to 30.",
              ),
          })
          .describe("One hook, named by its key."),
      )
      .optional()
      .describe(
        "Commands Zinn runs after each saved change, one after another in the order listed. Read only from the global settings file; zinn.local.json cannot set them.",
      ),
  })
  .meta({ title: "Zinn settings" });

export type Settings = z.infer<typeof settingsSchema>;
export type HookSettings = NonNullable<Settings["hooks"]>[string];
