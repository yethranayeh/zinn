import type { Task } from "../types";

import { getDb } from "../db";
import { DB_TABLE } from "../constant";

export function addTask(entry: {
  taskId: string;
  title: string;
  description: string | null;
  comments: string;
}) {
  return getDb()
    .query(`INSERT INTO ${DB_TABLE.taskSearch} (task_id, title, description, comments)
    VALUES ($taskId, $title, $description, $comments);`)
    .run({
      $taskId: entry.taskId,
      $title: entry.title,
      $description: entry.description,
      $comments: entry.comments,
    });
}

export function removeTask(taskId: string) {
  return getDb()
    .query(`DELETE FROM ${DB_TABLE.taskSearch} WHERE task_id = $taskId;`)
    .run({ $taskId: taskId });
}

export function searchTasks(props: { match: string; projectId?: string }) {
  const bindings: Record<string, string> = { $match: props.match };
  let projectClause = "";

  if (props.projectId != null) {
    projectClause = `AND ${DB_TABLE.task}.project_id = $project_id`;
    bindings.$project_id = props.projectId;
  }

  return getDb()
    .query<Task & { project_key: string }, Record<string, string>>(`SELECT
      ${DB_TABLE.task}.*,
      ${DB_TABLE.project}.key AS project_key
    FROM ${DB_TABLE.taskSearch}
    INNER JOIN ${DB_TABLE.task} ON ${DB_TABLE.task}.id = ${DB_TABLE.taskSearch}.task_id
    INNER JOIN ${DB_TABLE.project} ON ${DB_TABLE.project}.id = ${DB_TABLE.task}.project_id
    WHERE ${DB_TABLE.taskSearch} MATCH $match
      ${projectClause}
    ORDER BY bm25(${DB_TABLE.taskSearch}, 0.0, 3.0, 1.0, 1.0) ASC,
      ${DB_TABLE.project}.key ASC,
      ${DB_TABLE.task}.number ASC`)
    .all(bindings);
}
