import type { Bind, Task } from "../types";

import { getDb } from "../db";
import { DB_TABLE } from "../constant";

// TODO: refined parameters, preferably of type SQLBindings
export function getAll() {
  const db = getDb();
  return db.query<Task, any>(`SELECT * FROM ${DB_TABLE.task}`).all();
}

export function getAllByProjectId(projectId: string) {
  const db = getDb();
  return db
    .query<Task, Bind<Pick<Task, "project_id">>>(`SELECT *
    FROM ${DB_TABLE.task}
    WHERE project_id = $project_id`)
    .all({ $project_id: projectId });
}

export function create(task: Omit<Task, "archived_at">) {
  const db = getDb();

  const q = db.query<Task, Bind<Omit<Task, "archived_at">>>(`INSERT INTO
    ${DB_TABLE.task}  (id, project_id, number, name, description, task_order, created_at, updated_at)
    VALUES            ($id, $project_id, $number, $name, $description, $task_order, $created_at, $updated_at);`);

  return q.run({
    $id: task.id,
    $project_id: task.project_id,
    $number: task.number,
    $name: task.name,
    $description: task.description,
    $task_order: task.task_order,
    $created_at: task.created_at,
    $updated_at: task.updated_at,
  });
}
