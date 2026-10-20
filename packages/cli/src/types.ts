import type { CommandInput } from "./input.js";
import type { CommandResult } from "./results.js";

import { z } from "zod";

export const commandEffectsSchema = z.strictObject({
  domain: z.enum(["read", "create", "update", "delete", "replace", "none"]),
  storage: z.enum(["normal-open", "backup", "restore", "migrate", "reindex", "inspect", "none"]),
});
export const commandConfirmationSchema = z.strictObject({
  kind: z.enum(["none", "prompt", "project-delete"]),
  description: z.string().optional(),
});

export type Command = {
  input: CommandInput;
  results: readonly CommandResult[];
  summary: string;
  effects: z.infer<typeof commandEffectsSchema>;
  confirmation: z.infer<typeof commandConfirmationSchema>;
  run: (args: Array<string>) => void | Promise<void>;
  help: string;
  // For a flag that is **guessed** rather than what is actually available
  guessedFlags?: Record<string, (args: Array<string>) => Array<string>>;
};
export type ParsedRoute = {
  command: string;
  aliases: Array<Array<string>>;
} & Command;

export type RouteDef = { [key: string]: Command | RouteDef };
