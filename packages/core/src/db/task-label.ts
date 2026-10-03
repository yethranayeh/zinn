import type { Task, Label } from "../types";

import { getDb } from "../db";
import { DB_TABLE } from "../constant";
import { compareNames } from "../lib";

export function getAllByTaskId(taskId: string) {
  return getDb()
    .query<Label, [string]>(`SELECT label.* FROM ${DB_TABLE.label} AS label
    INNER JOIN ${DB_TABLE.taskLabel} AS attachment ON attachment.label_id = label.id
    WHERE attachment.task_id = ?`)
    .all(taskId)
    .sort(compareNames);
}

export function create(taskId: string, labelId: string) {
  return getDb()
    .query(`INSERT INTO ${DB_TABLE.taskLabel} (task_id, label_id)
    VALUES (?, ?) ON CONFLICT (task_id, label_id) DO NOTHING`)
    .run(taskId, labelId);
}

export function deleteByIds(taskId: string, labelId: string) {
  return getDb()
    .query(`DELETE FROM ${DB_TABLE.taskLabel}
    WHERE task_id = ? AND label_id = ?`)
    .run(taskId, labelId);
}

export function getTaskIdsByLabelId(labelId: string) {
  return getDb()
    .query<Pick<Task, "id">, [string]>(`SELECT task_id AS id FROM ${DB_TABLE.taskLabel}
    WHERE label_id = ?`)
    .all(labelId)
    .map((row) => row.id);
}
