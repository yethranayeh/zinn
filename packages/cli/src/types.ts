import type { CommandInput } from "./input.js";
import type { CommandResult } from "./results.js";

export type Command = {
  input: CommandInput;
  results: readonly CommandResult[];
  summary: string;
  effects: {
    domain: "read" | "create" | "update" | "delete" | "replace" | "none";
    storage: "normal-open" | "backup" | "restore" | "migrate" | "reindex" | "inspect" | "none";
  };
  confirmation: {
    kind: "none" | "prompt" | "project-delete";
    description?: string;
  };
  run: (args: Array<string>) => void | Promise<void>;
  help: string;
  // For a flag that is **guessed** rather than what is actually available
  guessedFlags?: Record<string, (args: Array<string>) => Array<string>>;
};
export type ParsedRoute = {
  command: string;
} & Command;

export type RouteDef = { [key: string]: Command | RouteDef };
