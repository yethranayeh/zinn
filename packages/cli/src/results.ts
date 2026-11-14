import type { ResultSchemaName } from "./result-schemas.js";

import { z } from "zod";

export const resultSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({ kind: z.literal("booleanOption"), name: z.string(), value: z.boolean() }),
  z.strictObject({
    kind: z.literal("positionalCount"),
    name: z.string(),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative().nullable(),
  }),
]);
export const resultReferenceSchema = z.string().regex(/^#\/schemas\/definitions\/[^/]+$/);
export const commandResultSchema = z.strictObject({
  selector: resultSelectorSchema,
  schemaRef: resultReferenceSchema,
  /**
   * json is one document,
   * json-lines is one document per line written as each becomes available
   */
  mode: z.enum(["json", "json-lines"]),
  stream: z.literal("stdout"),
  exitCode: z.literal(0),
  /** The same document arrives on stdout with this exit code when it reports findings */
  findingsExitCode: z.literal(1).optional(),
});
export type ResultSelector = z.infer<typeof resultSelectorSchema>;
export type CommandResult = z.infer<typeof commandResultSchema> & {
  schemaRef: `#/schemas/definitions/${ResultSchemaName}`;
};

export function jsonResult(
  schema: ResultSchemaName,
  selector: ResultSelector = { kind: "always" },
  mode: CommandResult["mode"] = "json",
): CommandResult {
  return {
    selector,
    schemaRef: `#/schemas/definitions/${schema}`,
    mode,
    stream: "stdout",
    exitCode: 0,
  };
}

export const taskDetailResults = [
  jsonResult("TaskDetail", { kind: "booleanOption", name: "history", value: false }),
  jsonResult("TaskDetailHistory", { kind: "booleanOption", name: "history", value: true }),
];
export const taskChangeResults = [
  jsonResult("TaskChange", { kind: "positionalCount", name: "task-key", min: 1, max: 1 }),
  jsonResult("TaskChanges", { kind: "positionalCount", name: "task-key", min: 2, max: null }),
];
