import { z } from "zod";
import {
  activityActionSchema,
  activityEntityTypeSchema,
  actorSchema,
  labelCreateSchema,
  relationCreateSchema,
  settingsSchema,
  taskCreateSchema,
} from "@zinn-dev/core";

import { errorDocumentSchema } from "./errors.js";
import { capabilitiesSchema, jsonValueSchema } from "./capabilities-schema.js";

const nullableText = z.string().nullable();
const count = z.number().int().nonnegative();
const timestamp = z.number().int().describe("Milliseconds since the Unix epoch.");
const taskStatus = z.enum(["Active", "Archived"]);

export const taskSchema = z.strictObject({
  key: z.string().describe("Readable project key and task number."),
  status: taskStatus,
  column: z.string().describe("Current column name."),
  title: z.string(),
  description: nullableText,
  priority: taskCreateSchema.shape.priority.unwrap(),
  labels: z.array(z.string()).describe("Attached label names."),
});

export const relationSchema = z.strictObject({
  type: relationCreateSchema.shape.relation_type,
  direction: z
    .enum(["outgoing", "incoming"])
    .nullable()
    .describe("Direction relative to the viewed task; null for a symmetric relation."),
  task: taskSchema.pick({ key: true, column: true, title: true, status: true }),
});
export const relationChangeSchema = z.strictObject({
  type: relationCreateSchema.shape.relation_type,
  source: z.string().describe("Source task key, in the supplied direction."),
  target: z.string().describe("Target task key, in the supplied direction."),
});

export const commentSchema = z.strictObject({
  key: z.string().describe("Readable task key and comment number."),
  text: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const activitySchema = z.strictObject({
  id: z.string().describe("Full activity event ID."),
  created_at: timestamp,
  actor_name: nullableText,
  actor_email: nullableText,
  actor_kind: actorSchema.shape.kind,
  actor_source: nullableText,
  actor_session_id: nullableText,
  actor_thread_id: nullableText,
  actor_agent: nullableText,
  actor_model: nullableText,
  actor_effort: nullableText,
  entity_type: activityEntityTypeSchema,
  entity_id: z.string().describe("Stored ID of the affected entity."),
  action: activityActionSchema,
  changes: z
    .looseObject({})
    .nullable()
    .describe(
      "Raw recorded JSON object, including unknown fields; null when no payload was recorded.",
    ),
});

export const taskDetailSchema = taskSchema.extend({
  relations: z.array(relationSchema),
  comments: z.array(commentSchema),
});
export const taskDetailHistorySchema = taskDetailSchema.extend({
  activity: z
    .array(activitySchema)
    .describe("Recorded activity, newest first; present even when empty."),
});
export const taskChangeSchema = taskSchema.extend({
  changed: z.boolean().describe("Whether this key occurrence changed the task's state."),
});

export const projectSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  description: nullableText,
});
export const columnSchema = z.strictObject({ project: z.string(), name: z.string() });
export const columnTaskCountSchema = z.strictObject({ name: z.string(), taskCount: count });
export const projectViewSchema = projectSchema.extend({
  columns: z.array(columnTaskCountSchema),
  archivedTaskCount: count,
});
export const labelSchema = z.strictObject({
  name: z.string(),
  color: labelCreateSchema.shape.color.unwrap(),
  description: nullableText,
});

const settingsFileBase = z.strictObject({
  path: z.string(),
  source: z.enum(["env", "global", "local"]),
});
export const settingsFileSchema = z.discriminatedUnion("state", [
  settingsFileBase.extend({ state: z.literal("found"), settings: settingsSchema }),
  settingsFileBase.extend({ state: z.literal("missing") }),
  settingsFileBase.extend({ state: z.literal("error"), error: z.string() }),
  settingsFileBase.extend({ state: z.literal("not-read"), reason: z.literal("ZINN_DIR") }),
]);
export const infoSchema = z.strictObject({
  settingsFiles: z.array(settingsFileSchema),
  storage: z.strictObject({
    directory: nullableText,
    source: z.enum(["env", "local", "global", "default"]).nullable(),
    settingsPath: nullableText,
    exists: z.boolean().nullable(),
    error: nullableText,
  }),
  defaultProject: z.strictObject({
    key: nullableText,
    settingsPath: nullableText,
    error: nullableText,
  }),
  database: z.strictObject({
    path: nullableText,
    state: z.enum(["absent", "empty", "unmarked", "current", "older", "newer", "unavailable"]),
    version: count.nullable(),
    latestVersion: count,
    error: nullableText,
  }),
  versions: z.strictObject({
    cli: z.string(),
    core: z.string(),
    runtime: z.strictObject({ name: z.enum(["Node", "Bun"]), version: z.string() }),
  }),
});

export const backupSchema = z.strictObject({ path: z.string() });
export const restoreSchema = z.strictObject({
  databasePath: z.string(),
  previousVersion: count.describe(
    "Destination schema version before restore; zero for an empty destination.",
  ),
  restoredVersion: count,
  backupPath: nullableText.describe(
    "Snapshot of the replaced database, or null when none was needed.",
  ),
});
export const migrateSchema = z.strictObject({
  databasePath: z.string(),
  previousVersion: count,
  finalVersion: count,
  changed: z.boolean(),
  backupPath: nullableText.describe("Snapshot taken before migration; null on a no-op."),
});
export const reindexSchema = z.strictObject({ databasePath: z.string(), taskCount: count });

export const resultSchemas = {
  Task: taskSchema,
  TaskList: z.array(taskSchema),
  TaskDetail: taskDetailSchema,
  TaskDetailHistory: taskDetailHistorySchema,
  TaskChange: taskChangeSchema,
  TaskChanges: z.array(taskChangeSchema).min(2),
  Relation: relationSchema,
  RelationList: z.array(relationSchema),
  RelationChange: relationChangeSchema,
  Comment: commentSchema,
  CommentList: z.array(commentSchema),
  Project: projectSchema,
  ProjectList: z.array(projectSchema),
  ProjectView: projectViewSchema,
  Column: columnSchema,
  ColumnTaskCount: columnTaskCountSchema,
  ColumnList: z.array(columnTaskCountSchema),
  Label: labelSchema,
  LabelList: z.array(labelSchema),
  Activity: activitySchema,
  ActivityList: z.array(activitySchema),
  Info: infoSchema,
  Backup: backupSchema,
  Restore: restoreSchema,
  Migrate: migrateSchema,
  Reindex: reindexSchema,
  ErrorEnvelope: errorDocumentSchema,
  Capabilities: capabilitiesSchema,
  JsonValue: jsonValueSchema,
};
export type ResultSchemaName = keyof typeof resultSchemas;
export type PresentedTask = z.infer<typeof taskSchema>;
export type PresentedTaskDetail = z.infer<typeof taskDetailSchema>;
export type PresentedTaskDetailHistory = z.infer<typeof taskDetailHistorySchema>;
export type PresentedTaskChange = z.infer<typeof taskChangeSchema>;
export type PresentedRelation = z.infer<typeof relationSchema>;
export type PresentedRelationChange = z.infer<typeof relationChangeSchema>;
export type PresentedComment = z.infer<typeof commentSchema>;
export type PresentedProject = z.infer<typeof projectSchema>;
export type PresentedProjectView = z.infer<typeof projectViewSchema>;
export type PresentedColumn = z.infer<typeof columnSchema>;
export type PresentedColumnTaskCount = z.infer<typeof columnTaskCountSchema>;
export type PresentedLabel = z.infer<typeof labelSchema>;
export type PresentedActivity = z.infer<typeof activitySchema>;
export type PresentedInfo = z.infer<typeof infoSchema>;
export type PresentedBackup = z.infer<typeof backupSchema>;
export type PresentedRestore = z.infer<typeof restoreSchema>;
export type PresentedMigrate = z.infer<typeof migrateSchema>;
export type PresentedReindex = z.infer<typeof reindexSchema>;

/** Generates local references against the extracted schemas document in draft-07 spec */
export function generateResultSchemas(schemas: Record<string, z.ZodType> = resultSchemas): {
  $schema: string;
  definitions: Record<string, z.core.JSONSchema.JSONSchema>;
} {
  const schemaVersion = "draft-07";
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) {
    registry.add(schema, { id });
  }

  const generated = z.toJSONSchema(registry, {
    target: schemaVersion,
    unrepresentable: "throw",
    uri: (id) => `#/definitions/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`,
  });

  function rebaseReferences(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        // Zod's shared document fragment becomes a path inside the embedded definition.
        (value as Record<string, unknown>)[key] = child.replace(
          /^(#\/definitions\/[^#]+)#\//,
          "$1/",
        );
      } else {
        rebaseReferences(child);
      }
    }
  }

  rebaseReferences(generated.schemas);

  const definitions = Object.fromEntries(
    Object.entries(generated.schemas).map(([name, schema]) => {
      // Embedded definitions share their document's base URI.
      const { $id, $schema, ...definition } = schema;
      return [name, definition];
    }),
  );

  return { $schema: `http://json-schema.org/${schemaVersion}/schema#`, definitions };
}
