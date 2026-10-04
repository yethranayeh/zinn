import type { Activity, ActivityEntityType, Bind } from "../types";

import { randomUUIDv7 } from "bun";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";

type StoredActivity = Omit<Activity, "changes"> & { changes: string | null };

export function create(props: Omit<Activity, "id">) {
  const db = getDb();

  db.query<never, Bind<StoredActivity>>(
    `INSERT INTO
    ${DB_TABLE.activity} (id, created_at, actor_name, actor_email, actor_kind, entity_type, entity_id, action, changes)
    VALUES               ($id, $created_at, $actor_name, $actor_email, $actor_kind, $entity_type, $entity_id, $action, $changes);`,
  ).run({
    $id: randomUUIDv7(),
    $created_at: props.created_at,
    $actor_name: props.actor_name,
    $actor_email: props.actor_email,
    $actor_kind: props.actor_kind,
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
    .map((row) => ({ ...row, changes: row.changes == null ? null : JSON.parse(row.changes) }));
}
