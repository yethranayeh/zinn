import { expect, test } from "bun:test";
import Ajv from "ajv";
import { z } from "zod";
import {
  activityActionSchema,
  activityEntityTypeSchema,
  actorKindSchema,
  labelColorSchema,
  relationTypeSchema,
  taskPrioritySchema,
} from "@zinn-dev/core";
import { generateResultSchemas, resultSchemas } from "./result-schemas";

const document = generateResultSchemas();
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
ajv.addSchema(document, "results");

test("every generated definition compiles, and every reference resolves locally", () => {
  expect(Object.keys(document.definitions).sort()).toEqual(Object.keys(resultSchemas).sort());
  for (const name of Object.keys(resultSchemas)) {
    expect(ajv.getSchema(`results#/definitions/${name}`)).toBeDefined();
  }
  function checkReferences(value: unknown) {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        expect(typeof child).toBe("string");
        expect((child as string).startsWith("#/definitions/")).toBe(true);
        const resolved = (child as string).slice(2).split("/").reduce<unknown>((node, part) =>
          (node as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")], document);
        expect(resolved).toBeDefined();
      } else {
        checkReferences(child);
      }
    }
  }
  checkReferences(document);
});

test("project list requires nested integer counts without changing the project contract", () => {
  const project = { id: "project-id", key: "APP", name: "App", description: null };
  const validate = ajv.getSchema("results#/definitions/ProjectList")!;
  expect(validate([{ ...project, taskCounts: { active: 0, archived: 0 } }])).toBe(true);
  expect(validate([{ ...project, taskCounts: { active: 12, archived: 4 } }])).toBe(true);
  expect(validate([project])).toBe(false);
  expect(validate([{ ...project, activeTaskCount: 12, archivedTaskCount: 4 }])).toBe(false);
  for (const field of Object.keys(resultSchemas.ProjectList.element.shape.taskCounts.shape)) {
    for (const value of [undefined, null, -1, 0.5, "1"]) {
      expect(validate([{ ...project, taskCounts: { active: 0, archived: 0, [field]: value } }])).toBe(false);
    }
  }
  expect(validate([{ ...project, taskCounts: { active: 0, archived: 0, total: 0 } }])).toBe(false);
  expect(resultSchemas.Project.safeParse(project).success).toBe(true);
  expect(resultSchemas.Project.safeParse({ ...project, taskCounts: { active: 0, archived: 0 } }).success).toBe(false);
});

test("recursive and shared definitions remain resolvable after embedding", () => {
  const json = z.json();
  const schemas = generateResultSchemas({
    Json: json,
    Container: z.strictObject({ left: json, right: json }),
    Automatic: z.strictObject({ nested: z.json() }),
  });
  const validator = new Ajv({ strict: true, allowUnionTypes: true });
  validator.addSchema(schemas, "recursive");
  const validate = validator.getSchema("recursive#/definitions/Container")!;
  expect(validate({ left: { nested: [null, { value: 3 }] }, right: [true] })).toBe(true);
  expect(validate({ left: {}, right: [], extra: true })).toBe(false);
  const automatic = validator.getSchema("recursive#/definitions/Automatic")!;
  expect(automatic({ nested: { list: [{ value: null }] } })).toBe(true);
  expect(automatic({ nested: {}, extra: true })).toBe(false);
});

test("unsupported schema conversions fail instead of emitting an unconstrained result", () => {
  for (const unsupported of [z.date(), z.bigint(), z.string().transform((text) => text.length)]) {
    expect(() => generateResultSchemas({ Unsupported: unsupported })).toThrow();
  }
});

test("wire schemas distinguish null, omission, history and mutation cardinality", () => {
  const task = { id: "task-id", key: "APP-1", project_id: "project-id", status: "Active", column: "Backlog", column_id: "column-id", is_first: true, is_last: false, title: "One", description: null, priority: null, due_at: null, labels: [], label_ids: [], created_at: 1, updated_at: 2 };
  function accepts(name: string, value: unknown) {
    return ajv.getSchema(`results#/definitions/${name}`)!(value);
  }
  expect(accepts("Task", task)).toBe(true);
  for (const field of Object.keys(task)) {
    const missing: Record<string, unknown> = { ...task };
    delete missing[field];
    expect(accepts("Task", missing)).toBe(false);
  }
  expect(accepts("Task", { ...task, status: "active" })).toBe(false);
  expect(accepts("Task", { ...task, priority: 1 })).toBe(false);
  expect(accepts("Task", { ...task, labels: null })).toBe(false);
  expect(accepts("Task", { ...task, extra: true })).toBe(false);
  const detail = { ...task, relations: [], comments: [] };
  expect(accepts("TaskDetail", detail)).toBe(true);
  expect(accepts("TaskDetail", { ...detail, activity: [] })).toBe(false);
  expect(accepts("TaskDetailHistory", detail)).toBe(false);
  expect(accepts("TaskDetailHistory", { ...detail, activity: [] })).toBe(true);
  expect(accepts("TaskDetailHistory", { ...detail, activity: null })).toBe(false);
  for (const field of ["created_at", "updated_at"]) {
    const missing: Record<string, unknown> = { ...detail };
    delete missing[field];
    expect(accepts("TaskDetail", missing)).toBe(false);
    expect(accepts("TaskDetailHistory", { ...missing, activity: [] })).toBe(false);
    expect(accepts("TaskDetail", { ...detail, [field]: "2026-10-24" })).toBe(false);
    for (const invalid of [null, "2026-10-24", 1.5]) {
      expect(accepts("Task", { ...task, [field]: invalid })).toBe(false);
    }
  }
  const change = { ...task, changed: false };
  expect(accepts("TaskChange", change)).toBe(true);
  expect(accepts("TaskChange", [change])).toBe(false);
  expect(accepts("TaskChanges", change)).toBe(false);
  expect(accepts("TaskChanges", [change])).toBe(false);
  expect(accepts("TaskChanges", [change, change])).toBe(true);
  for (const [name, schema] of Object.entries(resultSchemas)) {
    if (schema instanceof z.ZodArray && name !== "TaskChanges") {
      expect(accepts(name, [])).toBe(true);
      expect(accepts(name, null)).toBe(false);
      expect(accepts(name, {})).toBe(false);
    }
  }
});

test("raw changes remain open while activity and administrative objects are closed", () => {
  const activity = {
    id: "event", created_at: 1, actor_name: null, actor_email: null, actor_kind: "agent",
    actor_source: null, actor_session_id: null, actor_thread_id: null, actor_agent: null,
    actor_model: null, actor_effort: null, entity_type: "task", entity_id: "task-id", action: "order", changes: null,
  };
  const validate = ajv.getSchema("results#/definitions/Activity")!;
  expect(validate(activity)).toBe(true);
  expect(validate({ ...activity, changes: { future: { values: [null, true, 2, "x"] } } })).toBe(true);
  for (const changes of [[], "text", 3]) {
    expect(validate({ ...activity, changes })).toBe(false);
  }
  expect(validate({ ...activity, actor_kind: null })).toBe(false);
  expect(validate({ ...activity, extra: true })).toBe(false);
  const { changes, ...omitted } = activity;
  expect(validate(omitted)).toBe(false);
  const restore = ajv.getSchema("results#/definitions/Restore")!;
  const restored = { databasePath: "/store/data/zinn.sqlite", previousVersion: 0, restoredVersion: 2, backupPath: null };
  expect(restore(restored)).toBe(true);
  expect(restore({ ...restored, backupPath: undefined })).toBe(false);
  expect(restore({ ...restored, previousVersion: null })).toBe(false);
  expect(restore({ ...restored, extra: true })).toBe(false);
});

test("stored vocabularies accept unknown strings while input enums stay closed", () => {
  const vocabularies = [
    { output: resultSchemas.Task.shape.priority, input: taskPrioritySchema },
    { output: resultSchemas.Label.shape.color, input: labelColorSchema },
    { output: resultSchemas.Relation.shape.type, input: relationTypeSchema },
    { output: resultSchemas.RelationChange.shape.type, input: relationTypeSchema },
    { output: resultSchemas.Activity.shape.actor_kind, input: actorKindSchema },
    { output: resultSchemas.Activity.shape.entity_type, input: activityEntityTypeSchema },
    { output: resultSchemas.Activity.shape.action, input: activityActionSchema },
  ];
  for (const { output, input } of vocabularies) {
    const unknownValue = "future-value";
    expect(input.safeParse(unknownValue).success).toBe(false);
    expect(output.safeParse(unknownValue).success).toBe(true);
    for (const knownValue of input.options) {
      expect(output.description).toContain(knownValue);
      expect(output.safeParse(knownValue).success).toBe(true);
    }
    expect(output.safeParse(1).success).toBe(false);
  }
});
