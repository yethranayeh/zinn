import { z } from "zod";
import {
  activityActionSchema,
  activityEntityTypeSchema,
  actorKindSchema,
  infoDatabaseStateSchema,
  labelColorSchema,
  relationTypeSchema,
  settingsFileSourceSchema,
  settingsFileStateSchema,
  settingsSchema,
  storageSourceSchema,
  taskPrioritySchema,
  telemetryModeSchema,
  telemetrySourceSchema,
} from "@zinn-dev/core";

import { errorDocumentSchema } from "./errors.js";
import { capabilitiesSchema, jsonValueSchema } from "./capabilities-schema.js";

const nullableText = z.string().nullable();
const count = z.number().int().nonnegative();
const timestamp = z.number().int().describe("Milliseconds since the Unix epoch.");
const taskStatus = z.enum(["Active", "Archived"]);

export const taskSchema = z.strictObject({
  id: z.string().describe("Stored task ID."),
  key: z.string().describe("Readable project key and task number."),
  project_id: z.string().describe("Owning project ID."),
  status: taskStatus,
  column: z.string().describe("Current column name."),
  column_id: z.string().describe("Current column ID."),
  is_first: z.boolean().describe("Whether the task's column is the first column of its board."),
  is_last: z.boolean().describe("Whether the task's column is the last column of its board."),
  title: z.string(),
  description: nullableText,
  priority: z
    .string()
    .nullable()
    .describe(
      `Known priorities: ${taskPrioritySchema.options.join(", ")}. Other stored values may occur.`,
    ),
  due_at: timestamp
    .nullable()
    .describe("Exact deadline in epoch milliseconds, or null when unset."),
  labels: z.array(z.string()).describe("Attached label names."),
  label_ids: z.array(z.string()).describe("Attached label IDs, in the same order as labels."),
  created_at: timestamp,
  updated_at: timestamp,
});

export const relationSchema = z.strictObject({
  id: z.string().describe("Stored relation ID."),
  type: z
    .string()
    .describe(
      `Known relation types: ${relationTypeSchema.options.join(", ")}. Other stored values may occur.`,
    ),
  direction: z
    .enum(["outgoing", "incoming"])
    .nullable()
    .describe("Direction relative to the viewed task; null for a symmetric relation."),
  task: taskSchema.pick({
    id: true,
    key: true,
    project_id: true,
    column: true,
    column_id: true,
    is_first: true,
    is_last: true,
    title: true,
    status: true,
  }),
});
export const relationChangeSchema = z.strictObject({
  id: z.string().describe("Stored ID of the created or deleted relation."),
  type: relationSchema.shape.type,
  source: z.string().describe("Source task key, in the supplied direction."),
  source_task_id: z.string().describe("Task ID matching source, in the supplied direction."),
  target: z.string().describe("Target task key, in the supplied direction."),
  target_task_id: z.string().describe("Task ID matching target, in the supplied direction."),
});

export const commentSchema = z.strictObject({
  id: z.string().describe("Stored comment ID."),
  key: z.string().describe("Readable task key and comment number."),
  task_id: z.string().describe("Owning task ID."),
  text: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const activitySchema = z.strictObject({
  id: z.string().describe("Full activity event ID."),
  created_at: timestamp,
  actor_name: nullableText,
  actor_email: nullableText,
  actor_kind: z
    .string()
    .describe(
      `Known actor kinds: ${actorKindSchema.options.join(", ")}. Other stored values may occur.`,
    ),
  actor_source: nullableText,
  actor_session_id: nullableText,
  actor_thread_id: nullableText,
  actor_agent: nullableText,
  actor_model: nullableText,
  actor_effort: nullableText,
  actor_client: nullableText,
  entity_type: z
    .string()
    .describe(
      `Known entity types: ${activityEntityTypeSchema.options.join(", ")}. Other stored values may occur.`,
    ),
  entity_id: z.string().describe("Stored ID of the affected entity."),
  action: z
    .string()
    .describe(
      `Known actions: ${activityActionSchema.options.join(", ")}. Other stored values may occur.`,
    ),
  changes: z
    .looseObject({})
    .nullable()
    .describe(
      "Raw recorded JSON object, including unknown fields; null when no payload was recorded.",
    ),
});

export const actorSchema = activitySchema.pick({
  actor_name: true,
  actor_email: true,
  actor_kind: true,
  actor_source: true,
  actor_session_id: true,
  actor_thread_id: true,
  actor_agent: true,
  actor_model: true,
  actor_effort: true,
  actor_client: true,
});

export const taskAttributionSchema = actorSchema.extend({
  id: activitySchema.shape.id,
  created_at: timestamp,
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
  id: z.string().describe("Stored project ID."),
  key: z.string(),
  name: z.string(),
  description: nullableText,
});
export const projectChangeSchema = projectSchema.extend({
  changed: z.boolean().describe("Whether the project's fields changed."),
});
export const projectListEntrySchema = projectSchema.extend({
  taskCounts: z.strictObject({
    active: count.describe("Unarchived tasks in any column."),
    archived: count.describe("Archived tasks."),
  }),
});
export const columnSchema = z.strictObject({
  id: z.string().describe("Stored column ID."),
  project: z.string(),
  project_id: z.string().describe("Owning project ID."),
  name: z.string(),
  is_first: z.boolean().describe("Whether this column is the first column of its board."),
  is_last: z.boolean().describe("Whether this column is the last column of its board."),
});
export const columnChangeSchema = columnSchema.extend({
  changed: z.boolean().describe("Whether the column's name or position changed."),
});
export const columnTaskCountSchema = z.strictObject({
  id: columnSchema.shape.id,
  name: z.string(),
  is_first: columnSchema.shape.is_first,
  is_last: columnSchema.shape.is_last,
  taskCount: count,
});
export const projectViewSchema = projectSchema.extend({
  columns: z.array(columnTaskCountSchema),
  archivedTaskCount: count,
});
export const labelSchema = z.strictObject({
  id: z.string().describe("Stored label ID."),
  name: z.string(),
  color: z
    .string()
    .describe(
      `Known label colors: ${labelColorSchema.options.join(", ")}. Other stored values may occur.`,
    ),
  description: nullableText,
});
export const labelChangeSchema = labelSchema.extend({
  changed: z.boolean().describe("Whether the label's fields changed."),
});
const blameTaskIdentity = taskSchema.pick({ id: true, key: true });
function blamedValue<S extends z.ZodType>(value: S) {
  return z.strictObject({ value, attribution: taskAttributionSchema.nullable() });
}

export const taskBlameSchema = z.strictObject({
  task: blameTaskIdentity,
  fields: z.strictObject({
    title: blamedValue(z.string()),
    column: blamedValue(columnSchema.pick({ id: true, name: true })),
    priority: blamedValue(taskSchema.shape.priority),
    due_at: blamedValue(taskSchema.shape.due_at),
    labels: blamedValue(z.array(labelSchema.pick({ id: true, name: true }))),
    parent: blamedValue(blameTaskIdentity.nullable()),
  }),
  relations: z.array(
    z.strictObject({
      id: relationSchema.shape.id,
      type: relationSchema.shape.type,
      direction: relationSchema.shape.direction,
      task: blameTaskIdentity,
      attribution: taskAttributionSchema.nullable(),
    }),
  ),
  description: z.array(
    z.strictObject({
      line: z.number().int().positive(),
      text: z.string(),
      attribution: taskAttributionSchema.nullable(),
    }),
  ),
});
export const commentChangeSchema = commentSchema.extend({
  changed: z.boolean().describe("Whether the comment's text changed."),
});

const settingsFileBase = z.strictObject({
  path: z.string(),
  source: settingsFileSourceSchema,
});
export const settingsFileSchema = z.discriminatedUnion("state", [
  settingsFileBase.extend({
    state: settingsFileStateSchema.extract(["found"]),
    settings: settingsSchema,
  }),
  settingsFileBase.extend({ state: settingsFileStateSchema.extract(["missing"]) }),
  settingsFileBase.extend({ state: settingsFileStateSchema.extract(["error"]), error: z.string() }),
  settingsFileBase.extend({
    state: settingsFileStateSchema.extract(["not-read"]),
    reason: z.literal("ZINN_DIR"),
  }),
]);
export const infoSchema = z.strictObject({
  settingsFiles: z.array(settingsFileSchema),
  storage: z.strictObject({
    directory: nullableText,
    source: storageSourceSchema.nullable(),
    settingsPath: nullableText,
    exists: z.boolean().nullable(),
    error: nullableText,
  }),
  defaultProject: z.strictObject({
    key: nullableText,
    settingsPath: nullableText,
    error: nullableText,
  }),
  telemetry: z.strictObject({
    mode: telemetryModeSchema.nullable(),
    source: telemetrySourceSchema.nullable(),
    settingsPath: nullableText,
    maxMegabytes: z.number().int().positive().nullable(),
    directory: nullableText,
    exists: z.boolean().nullable(),
    sizeBytes: count.nullable(),
    error: nullableText,
  }),
  database: z.strictObject({
    path: nullableText,
    state: infoDatabaseStateSchema,
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
    "Destination schema version before restore; zero when the destination had no schema version. backupPath says whether it was replaced.",
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
  TaskBlame: taskBlameSchema,
  TaskDetailHistory: taskDetailHistorySchema,
  TaskChange: taskChangeSchema,
  TaskChanges: z.array(taskChangeSchema).min(2),
  Relation: relationSchema,
  RelationList: z.array(relationSchema),
  RelationChange: relationChangeSchema,
  Comment: commentSchema,
  CommentChange: commentChangeSchema,
  CommentList: z.array(commentSchema),
  Project: projectSchema,
  ProjectChange: projectChangeSchema,
  ProjectList: z.array(projectListEntrySchema),
  ProjectView: projectViewSchema,
  Column: columnSchema,
  ColumnChange: columnChangeSchema,
  ColumnTaskCount: columnTaskCountSchema,
  ColumnList: z.array(columnTaskCountSchema),
  Label: labelSchema,
  LabelChange: labelChangeSchema,
  LabelList: z.array(labelSchema),
  Activity: activitySchema,
  ActivityList: z.array(activitySchema),
  Actor: actorSchema,
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
export type PresentedTaskBlame = z.infer<typeof taskBlameSchema>;
export type PresentedTaskDetail = z.infer<typeof taskDetailSchema>;
export type PresentedTaskDetailHistory = z.infer<typeof taskDetailHistorySchema>;
export type PresentedTaskChange = z.infer<typeof taskChangeSchema>;
export type PresentedRelation = z.infer<typeof relationSchema>;
export type PresentedRelationChange = z.infer<typeof relationChangeSchema>;
export type PresentedComment = z.infer<typeof commentSchema>;
export type PresentedProject = z.infer<typeof projectSchema>;
export type PresentedProjectListEntry = z.infer<typeof projectListEntrySchema>;
export type PresentedProjectView = z.infer<typeof projectViewSchema>;
export type PresentedColumn = z.infer<typeof columnSchema>;
export type PresentedColumnTaskCount = z.infer<typeof columnTaskCountSchema>;
export type PresentedLabel = z.infer<typeof labelSchema>;
export type PresentedActivity = z.infer<typeof activitySchema>;
export type PresentedActor = z.infer<typeof actorSchema>;
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
