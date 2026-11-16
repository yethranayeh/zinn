import type { Task, Label } from "../types.js";

import { getDb } from "../db.js";
import { DB_TABLE } from "../constant.js";
import { compareNames } from "../lib.js";

/** Returns the labels of each given task in one query, keyed by task ID and sorted by name */
export function getAllByTaskIds(taskIds: ReadonlyArray<string>) {
  const labelsByTaskId = new Map<string, Array<Label>>(taskIds.map((taskId) => [taskId, []]));

  if (taskIds.length === 0) {
    return labelsByTaskId;
  }

  const rows = getDb()
    .query<Label & { task_id: string }, { $taskIds: string }>(`SELECT attachment.task_id, label.*
    FROM ${DB_TABLE.label} AS label
    INNER JOIN ${DB_TABLE.taskLabel} AS attachment ON attachment.label_id = label.id
    WHERE attachment.task_id IN (SELECT value FROM json_each($taskIds))`)
    .all({ $taskIds: JSON.stringify(taskIds) });

  for (const { task_id, ...label } of rows) {
    labelsByTaskId.get(task_id)!.push(label);
  }

  for (const labels of labelsByTaskId.values()) {
    labels.sort(compareNames);
  }

  return labelsByTaskId;
}

export function getAllByTaskId(taskId: string) {
  return getAllByTaskIds([taskId]).get(taskId)!;
}

export function create(taskId: string, labelId: string) {
  getDb()
    .query(`INSERT INTO ${DB_TABLE.taskLabel} (task_id, label_id)
    VALUES (?, ?) ON CONFLICT (task_id, label_id) DO NOTHING`)
    .run(taskId, labelId);
}

export function deleteByIds(taskId: string, labelId: string) {
  getDb()
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
