import type { Activity, ActivityEntityType, Bind } from "../types.js";
import type { ActivityListInput } from "../schemas/activity.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";

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
      actor_source, actor_session_id, actor_thread_id, actor_agent, actor_model, actor_effort,
      entity_type, entity_id, action, changes
    ) VALUES (
      $id, $created_at, $actor_name, $actor_email, $actor_kind,
      $actor_source, $actor_session_id, $actor_thread_id, $actor_agent, $actor_model, $actor_effort,
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
    $entity_type: props.entity_type,
    $entity_id: props.entity_id,
    $action: props.action,
    $changes: props.changes == null ? null : JSON.stringify(props.changes),
  });

  return { id, ...props };
}

export function getAllByEntity(entityType: ActivityEntityType, entityId: string): Array<Activity> {
  const db = getDb();

  return db
    .query<StoredActivity, Bind<{ entityType: ActivityEntityType; entityId: string }>>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE entity_type = $entityType AND entity_id = $entityId
    ORDER BY id ASC`,
    )
    .all({ $entityType: entityType, $entityId: entityId })
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
  const limit = input.limit === undefined ? "" : " LIMIT $limit";

  if (input.limit !== undefined) {
    bindings.$limit = input.limit;
  }

  return getDb()
    .query<StoredActivity, typeof bindings>(
      `SELECT * FROM ${DB_TABLE.activity}${where} ORDER BY created_at DESC, id DESC${limit}`,
    )
    .all(bindings)
    .map(parseActivity);
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
 * Returns task deletions, and project deletions with a task snapshot, that recorded the task ID
 *  or the task key in any ASCII case, with newest being served first
 */
export function getTaskDeletionEvents(match: { taskId?: string; taskKey?: string }) {
  return getDb()
    .query<StoredActivity, { $taskId: string | null; $taskKey: string | null }>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE action = 'delete' AND (
      (entity_type = 'task'
        AND (entity_id = $taskId OR UPPER(json_extract(changes, '$.key')) = $taskKey))
      OR (entity_type = 'project' AND EXISTS (
        SELECT 1 FROM json_each(changes, '$.tasks') AS snapshot
        WHERE CASE WHEN snapshot.type = 'object'
          THEN json_extract(snapshot.value, '$.id') = $taskId
            OR UPPER(json_extract(snapshot.value, '$.key')) = $taskKey
        END)))
    ORDER BY created_at DESC, id DESC`,
    )
    .all({ $taskId: match.taskId ?? null, $taskKey: match.taskKey ?? null })
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
