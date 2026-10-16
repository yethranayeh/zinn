import type { Activity, ActivityEntityType, Bind } from "../types.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";

type StoredActivity = Omit<Activity, "changes"> & { changes: string | null };

function parseActivity(row: StoredActivity): Activity {
  return {
    ...row,
    actor_source: row.actor_source ?? null,
    actor_session_id: row.actor_session_id ?? null,
    actor_thread_id: row.actor_thread_id ?? null,
    actor_agent: row.actor_agent ?? null,
    actor_model: row.actor_model ?? null,
    actor_effort: row.actor_effort ?? null,
    changes: row.changes == null ? null : JSON.parse(row.changes),
  };
}

export function create(props: Omit<Activity, "id">) {
  const db = getDb();

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
    $id: uuidv7(),
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

export function getAll(): Array<Activity> {
  return getDb()
    .query<StoredActivity>(`SELECT * FROM ${DB_TABLE.activity} ORDER BY created_at DESC, id DESC`)
    .all()
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
): Array<Activity> {
  return getDb()
    .query<StoredActivity, [string, string]>(
      `SELECT * FROM ${DB_TABLE.activity}
    WHERE (entity_type = 'task' AND entity_id IN (SELECT value FROM json_each(?)))
      OR id IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC, id DESC`,
    )
    .all(JSON.stringify(taskIds), JSON.stringify(projectDeletionIds))
    .map(parseActivity);
}
