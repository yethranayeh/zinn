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

export function getLatestTaskEventTimes(taskIds: Array<string>) {
  if (taskIds.length === 0) {
    return [];
  }

  return getDb()
    .query<{ entity_id: string; created_at: number }, [string]>(
      `SELECT entity_id, MAX(created_at) AS created_at FROM ${DB_TABLE.activity}
      WHERE entity_type = 'task' AND entity_id IN (SELECT value FROM json_each(?))
      GROUP BY entity_id`,
    )
    .all(JSON.stringify(taskIds));
}

export type ActivityQuery = Pick<
  ActivityListInput,
  "sessionId" | "threadId" | "since" | "until" | "actions"
> & {
  before?: Pick<Activity, "created_at" | "id">;
  limit?: number;
  eventIds?: Array<string>;
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

  if (input.eventIds !== undefined) {
    predicates.push("id IN (SELECT value FROM json_each($eventIds))");
    bindings.$eventIds = JSON.stringify(input.eventIds);
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

export function getTaskDeletionEvents(): Array<Activity> {
  return getDb()
    .query<StoredActivity>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE action = 'delete' AND entity_type IN ('task', 'project')
    ORDER BY created_at DESC, id DESC`,
    )
    .all()
    .map(parseActivity);
}

export function getAllForTasks(
  taskIds: Array<string>,
  projectDeletionIds: Array<string>,
  input: ActivityQuery = {},
): Array<Activity> {
  return getAll({ ...input, taskIds, projectDeletionIds });
}
