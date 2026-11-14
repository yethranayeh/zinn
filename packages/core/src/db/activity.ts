import type { Activity, ActivityEntityType, Bind } from "../types.js";
import type { ActivityListInput } from "../schemas/activity.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";
import { readSchemaVersion } from "../migrations/runner.js";

type StoredActivity = Omit<Activity, "changes"> & { changes: string | null };

function parseActivity(row: StoredActivity): Activity {
  return {
    id: row.id,
    created_at: row.created_at,
    actor_name: row.actor_name,
    actor_email: row.actor_email,
    actor_kind: row.actor_kind,
    actor_source: row.actor_source ?? null,
    actor_session_id: row.actor_session_id ?? null,
    actor_thread_id: row.actor_thread_id ?? null,
    actor_agent: row.actor_agent ?? null,
    actor_model: row.actor_model ?? null,
    actor_effort: row.actor_effort ?? null,
    actor_client: row.actor_client ?? null,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    changes: row.changes == null ? null : JSON.parse(row.changes),
  };
}

export function create(props: Omit<Activity, "id">): Activity {
  const db = getDb();
  const id = uuidv7();

  db.query<never, Bind<StoredActivity>>(
    `INSERT INTO
    ${DB_TABLE.activity} (
      id, created_at, actor_name, actor_email, actor_kind,
      actor_source, actor_session_id, actor_thread_id, actor_agent, actor_model, actor_effort, actor_client,
      entity_type, entity_id, action, changes
    ) VALUES (
      $id, $created_at, $actor_name, $actor_email, $actor_kind,
      $actor_source, $actor_session_id, $actor_thread_id, $actor_agent, $actor_model, $actor_effort, $actor_client,
      $entity_type, $entity_id, $action, $changes
    );`,
  ).run({
    $id: id,
    $created_at: props.created_at,
    $actor_name: props.actor_name,
    $actor_email: props.actor_email,
    $actor_kind: props.actor_kind,
    $actor_source: props.actor_source,
    $actor_session_id: props.actor_session_id,
    $actor_thread_id: props.actor_thread_id,
    $actor_agent: props.actor_agent,
    $actor_model: props.actor_model,
    $actor_effort: props.actor_effort,
    $actor_client: props.actor_client,
    $entity_type: props.entity_type,
    $entity_id: props.entity_id,
    $action: props.action,
    $changes: props.changes == null ? null : JSON.stringify(props.changes),
  });

  return { id, ...props };
}

export function getAllByEntity(
  entityType: ActivityEntityType,
  entityId: string,
  actions?: Array<Activity["action"]>,
): Array<Activity> {
  const db = getDb();
  const bindings: Record<string, string> = { $entityType: entityType, $entityId: entityId };
  let actionFilter = "";

  if (actions !== undefined) {
    actionFilter = "AND action IN (SELECT value FROM json_each($actions))";
    bindings.$actions = JSON.stringify(actions);
  }

  return db
    .query<StoredActivity, typeof bindings>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE entity_type = $entityType AND entity_id = $entityId ${actionFilter}
    ORDER BY id ASC`,
    )
    .all(bindings)
    .map(parseActivity);
}

/** The projects, columns and tasks that form a project's history through events */
export type ActivityMembers = {
  projectIds: Array<string>;
  columnIds: Array<string>;
  taskIds: Array<string>;
};

export type ActivityQuery = Pick<
  ActivityListInput,
  "sessionId" | "threadId" | "since" | "until" | "actions"
> & {
  before?: Pick<Activity, "created_at" | "id">;
  /** Selects the events stored after this position and returns them oldest first */
  afterPosition?: number;
  limit?: number;
  members?: ActivityMembers;
  taskIds?: Array<string>;
  projectDeletionIds?: Array<string>;
};

export function getAll(input: ActivityQuery = {}): Array<Activity> {
  const predicates: Array<string> = [];
  const bindings: Record<string, string | number> = {};
  for (const [field, column] of [
    ["sessionId", "actor_session_id"],
    ["threadId", "actor_thread_id"],
    ["since", "created_at"],
    ["until", "created_at"],
  ] as const) {
    const value = input[field];
    if (value !== undefined) {
      const operator = field === "since" ? ">=" : field === "until" ? "<=" : "=";
      predicates.push(`${column} ${operator} $${field}`);
      bindings[`$${field}`] = value;
    }
  }

  if (input.actions !== undefined) {
    predicates.push("action IN (SELECT value FROM json_each($actions))");
    bindings.$actions = JSON.stringify(input.actions);
  }

  if (input.before !== undefined) {
    predicates.push("(created_at, id) < ($createdAt, $id)");
    bindings.$createdAt = input.before.created_at;
    bindings.$id = input.before.id;
  }

  if (input.afterPosition !== undefined) {
    predicates.push("rowid > $afterPosition");
    bindings.$afterPosition = input.afterPosition;
  }

  if (input.members !== undefined) {
    predicates.push(`((entity_type = 'project' AND entity_id IN (SELECT value FROM json_each($memberProjectIds)))
      OR (entity_type = 'column' AND entity_id IN (SELECT value FROM json_each($memberColumnIds)))
      OR (entity_type = 'task' AND entity_id IN (SELECT value FROM json_each($memberTaskIds))))`);
    bindings.$memberProjectIds = JSON.stringify(input.members.projectIds);
    bindings.$memberColumnIds = JSON.stringify(input.members.columnIds);
    bindings.$memberTaskIds = JSON.stringify(input.members.taskIds);
  }

  if (input.taskIds !== undefined) {
    predicates.push(`((entity_type = 'task' AND entity_id IN (SELECT value FROM json_each($taskIds)))
      OR id IN (SELECT value FROM json_each($projectDeletionIds)))`);
    bindings.$taskIds = JSON.stringify(input.taskIds);
    bindings.$projectDeletionIds = JSON.stringify(input.projectDeletionIds ?? []);
  }

  const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
  const order = input.afterPosition === undefined ? "created_at DESC, id DESC" : "rowid ASC";
  const limit = input.limit === undefined ? "" : " LIMIT $limit";

  if (input.limit !== undefined) {
    bindings.$limit = input.limit;
  }

  return getDb()
    .query<StoredActivity, typeof bindings>(
      `SELECT * FROM ${DB_TABLE.activity}${where} ORDER BY ${order}${limit}`,
    )
    .all(bindings)
    .map(parseActivity);
}

/**
 * A value that changes whenever another connection commits a write from SQLite's `PRAGMA data_version`.
 * This connection's own writes leave it unchanged.
 * @link https://www.sqlite.org/pragma.html#pragma_data_version
 */
export function readDataVersion() {
  return getDb().query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
}

/**
 * A value that changes whenever this connection writes or another connection commits a write,
 *  from SQLite's `total_changes()` and the data version
 */
export function getWriteMarker() {
  const { changes } = getDb()
    .query<{ changes: number }, []>("SELECT total_changes() AS changes")
    .get()!;

  return `${changes}:${readDataVersion()}`;
}

/**
 * The position of the newest stored event, which is `0` if there is none.
 * It is the table's `rowid`, which grows with every stored event, so positions follow commit order
 *  even when an event's timestamp was taken before another writer's commit.
 * @link https://www.sqlite.org/autoinc.html
 */
export function readLastPosition() {
  const { position } = getDb()
    .query<{ position: number | null }, []>(
      `SELECT MAX(rowid) AS position FROM ${DB_TABLE.activity}`,
    )
    .get()!;

  return position ?? 0;
}

/**
 * A value that changes when another connection replaces tables or sets another schema version,
 *  as a restore, a migration and a reindex do. From SQLite's schema cookie and `PRAGMA user_version`.
 * @link https://www.sqlite.org/pragma.html#pragma_schema_version
 */
export function readSchemaMarker() {
  const connection = getDb();
  const { schema_version } = connection
    .query<{ schema_version: number }, []>("PRAGMA schema_version")
    .get()!;

  return `${schema_version}:${readSchemaVersion(connection)}`;
}

export function getIds(): Array<string> {
  return getDb()
    .query<{ id: string }>(`SELECT id FROM ${DB_TABLE.activity}`)
    .all()
    .map((row) => row.id);
}

export function getByIdPrefix(hexPrefix: string): Array<Activity> {
  return getDb()
    .query<StoredActivity, [string]>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE LOWER(REPLACE(id, '-', '')) LIKE ?
    ORDER BY id ASC`,
    )
    .all(`${hexPrefix}%`)
    .map(parseActivity);
}

/**
 * Returns task deletions, and project deletions with a task snapshot that recorded one of the
 *  task IDs or one of the task keys in any ASCII case, with newest being served first
 */
export type TaskDeletionMatch = { taskIds?: Array<string>; taskKeys?: Array<string> };

export function getTaskDeletionEvents(match: Required<TaskDeletionMatch>) {
  return getDb()
    .query<StoredActivity, { $taskIds: string; $taskKeys: string }>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE action = 'delete' AND (
      (entity_type = 'task'
        AND (entity_id IN (SELECT value FROM json_each($taskIds))
          OR UPPER(json_extract(changes, '$.key')) IN (SELECT value FROM json_each($taskKeys))))
      OR (entity_type = 'project' AND EXISTS (
        SELECT 1 FROM json_each(changes, '$.tasks') AS snapshot
        WHERE CASE WHEN snapshot.type = 'object'
          THEN json_extract(snapshot.value, '$.id') IN (SELECT value FROM json_each($taskIds))
            OR UPPER(json_extract(snapshot.value, '$.key')) IN (SELECT value FROM json_each($taskKeys))
        END)))
    ORDER BY created_at DESC, id DESC`,
    )
    .all({ $taskIds: JSON.stringify(match.taskIds), $taskKeys: JSON.stringify(match.taskKeys) })
    .map(parseActivity);
}

/** Returns the IDs of projects whose create or delete event recorded the key in any ASCII case */
export function getProjectIdsByRecordedKey(projectKey: string) {
  return getDb()
    .query<{ entity_id: string }, { $projectKey: string }>(
      `SELECT DISTINCT entity_id FROM ${DB_TABLE.activity}
    WHERE entity_type = 'project' AND action IN ('create', 'delete')
      AND UPPER(json_extract(changes, '$.key')) = $projectKey`,
    )
    .all({ $projectKey: projectKey })
    .map((row) => row.entity_id);
}

/** Returns the IDs of columns whose create event recorded one of the projects */
export function getColumnIdsCreatedInProjects(projectIds: Array<string>) {
  return getDb()
    .query<{ entity_id: string }, { $projectIds: string }>(
      `SELECT entity_id FROM ${DB_TABLE.activity}
    WHERE entity_type = 'column' AND action = 'create'
      AND json_extract(changes, '$.project.id') IN (SELECT value FROM json_each($projectIds))`,
    )
    .all({ $projectIds: JSON.stringify(projectIds) })
    .map((row) => row.entity_id);
}

/** Returns the IDs of tasks created in, or moved from or to, one of the columns */
export function getTaskIdsRecordedInColumns(columnIds: Array<string>) {
  return getDb()
    .query<{ entity_id: string }, { $columnIds: string }>(
      `SELECT DISTINCT entity_id FROM ${DB_TABLE.activity}
    WHERE entity_type = 'task' AND (
      (action = 'create'
        AND json_extract(changes, '$.column.id') IN (SELECT value FROM json_each($columnIds)))
      OR (action = 'move' AND json_type(changes, '$.column') = 'array' AND EXISTS (
        SELECT 1 FROM json_each(changes, '$.column') AS recorded
        WHERE CASE WHEN recorded.type = 'object' THEN json_extract(recorded.value, '$.id') END
          IN (SELECT value FROM json_each($columnIds)))))`,
    )
    .all({ $columnIds: JSON.stringify(columnIds) })
    .map((row) => row.entity_id);
}

export function getAllForTasks(
  taskIds: Array<string>,
  projectDeletionIds: Array<string>,
  input: ActivityQuery = {},
): Array<Activity> {
  return getAll({ ...input, taskIds, projectDeletionIds });
}
