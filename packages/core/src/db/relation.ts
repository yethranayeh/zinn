import type { Bind, TaskRelation } from "../types.js";

import { v7 as uuidv7 } from "uuid";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";

export function getAll() {
  const db = getDb();
  return db.query<TaskRelation, any>(`SELECT * FROM ${DB_TABLE.task_relations}`).all();
}

export function getAllByTaskId(taskId: string) {
  const db = getDb();

  return db
    .query<TaskRelation, Bind<{ taskId: string }>>(`SELECT * FROM ${DB_TABLE.task_relations}
    WHERE source_task_id = $taskId OR target_task_id = $taskId
    ORDER BY created_at ASC, id ASC`)
    .all({ $taskId: taskId });
}

/** Returns all ancestors, excluding the supplied task itself */
export function getAncestorIds(taskId: string, excludedRelationIds: Array<string> = []) {
  return getDb()
    .query<
      { id: string },
      Bind<{ taskId: string; excluded: string }>
    >(`WITH RECURSIVE ancestors(id) AS (
      SELECT target_task_id FROM ${DB_TABLE.task_relations}
      WHERE source_task_id = $taskId AND relation_type = 'subtask'
        AND id NOT IN (SELECT value FROM json_each($excluded))
      UNION ALL
      SELECT relation.target_task_id FROM ${DB_TABLE.task_relations} AS relation
      JOIN ancestors ON relation.source_task_id = ancestors.id
      WHERE relation.relation_type = 'subtask'
        AND relation.id NOT IN (SELECT value FROM json_each($excluded))
    )
    SELECT id FROM ancestors`)
    .all({ $taskId: taskId, $excluded: JSON.stringify(excludedRelationIds) })
    .map((ancestor) => ancestor.id);
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
export function create(
  props: Omit<CreateTaskRelationInput, "id" | "created_at">,
  createdAt = Date.now(),
) {
  const db = getDb();

  const query = db.query<TaskRelation, Bind<CreateTaskRelationInput>>(`INSERT INTO
    ${DB_TABLE.task_relations} (id, source_task_id, target_task_id, relation_type, created_at)
    VALUES              ($id, $source_task_id, $target_task_id, $relation_type, $created_at)
    RETURNING *;`);

  return query.get({
    $id: uuidv7(),
    $source_task_id: props.source_task_id,
    $target_task_id: props.target_task_id,
    $relation_type: props.relation_type,
    $created_at: createdAt,
  });
}

export function deleteById(id: string) {
  const db = getDb();

  db.query<never, Bind<Pick<TaskRelation, "id">>>(
    `DELETE FROM ${DB_TABLE.task_relations} WHERE id = $id;`,
  ).run({ $id: id });
}
