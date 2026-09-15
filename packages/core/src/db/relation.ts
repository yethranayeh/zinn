import type { Bind, TaskRelation } from "../types";

import { randomUUIDv7 } from "bun";

import { DB_TABLE } from "../constant";
import { getDb } from "../db";

export function getAll() {
  const db = getDb();
  return db.query<TaskRelation, any>(`SELECT * FROM ${DB_TABLE.task_relations}`).all();
}

export function getAllByTaskId(taskId: string) {
  const db = getDb();

  return db
    .query<TaskRelation, Bind<{ taskId: string }>>(`SELECT * FROM ${DB_TABLE.task_relations}
    WHERE source_task_id = $taskId OR target_task_id = $taskId`)
    .all({ $taskId: taskId });
}

export function getByTaskIdsAndType(
  props: Pick<TaskRelation, "source_task_id" | "target_task_id" | "relation_type">,
) {
  const db = getDb();

  return db
    .query<TaskRelation, Bind<typeof props>>(`SELECT * FROM ${DB_TABLE.task_relations}
    WHERE source_task_id = $source_task_id
      AND target_task_id = $target_task_id
      AND relation_type = $relation_type`)
    .get({
      $source_task_id: props.source_task_id,
      $target_task_id: props.target_task_id,
      $relation_type: props.relation_type,
    });
}

type CreateTaskRelationInput = Pick<
  TaskRelation,
  "id" | "source_task_id" | "target_task_id" | "relation_type" | "created_at"
>;
export function create(props: Omit<CreateTaskRelationInput, "id" | "created_at">) {
  const db = getDb();

  const query = db.query<TaskRelation, Bind<CreateTaskRelationInput>>(`INSERT INTO
    ${DB_TABLE.task_relations} (id, source_task_id, target_task_id, relation_type, created_at)
    VALUES              ($id, $source_task_id, $target_task_id, $relation_type, $created_at)
    RETURNING *;`);

  return query.get({
    $id: randomUUIDv7(),
    $source_task_id: props.source_task_id,
    $target_task_id: props.target_task_id,
    $relation_type: props.relation_type,
    $created_at: Date.now(),
  });
}
