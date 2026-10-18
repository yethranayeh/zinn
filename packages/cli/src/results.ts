import type { ResultSchemaName } from "./result-schemas.js";

export type ResultSelector =
  | { kind: "always" }
  | { kind: "booleanOption"; name: string; value: boolean }
  | { kind: "positionalCount"; name: string; min: number; max: number | null };

export type CommandResult = {
  selector: ResultSelector;
  schemaRef: `#/schemas/definitions/${ResultSchemaName}`;
  mode: "json";
  stream: "stdout";
  exitCode: 0;
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
