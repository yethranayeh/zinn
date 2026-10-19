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
  mode: z.literal("json"),
  stream: z.literal("stdout"),
  exitCode: z.literal(0),
});
export type ResultSelector = z.infer<typeof resultSelectorSchema>;
export type CommandResult = z.infer<typeof commandResultSchema> & {
  schemaRef: `#/schemas/definitions/${ResultSchemaName}`;
};

export function jsonResult(
  schema: ResultSchemaName,
  selector: ResultSelector = { kind: "always" },
): CommandResult {
  return {
    selector,
    schemaRef: `#/schemas/definitions/${schema}`,
    mode: "json",
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
