import type { Bind, Column } from "../types.js";
import type { Database } from "../sqlite/database.js";

import { DB_TABLE } from "../constant.js";
import { getDb } from "../db.js";

type ExistingTask = { project_key: string; number: number };

/** Reads column context through an inspection connection rather than the normal database opener. */
export function inspectContext(
  db: Database,
  tasks: Array<{ projectKey: string; taskNumber: number }>,
) {
  const projects = db
    .query<{ id: string; key: string }>("SELECT id, key FROM project ORDER BY key")
    .all();
  const columns = db
    .query<Pick<Column, "project_id" | "name">>(
      "SELECT project_id, name FROM project_column ORDER BY column_order",
    )
    .all();
  const existingTasks: Array<ExistingTask> = [];

  if (tasks.length > 0) {
    const taskQuery = db.query<ExistingTask>(
      `SELECT project.key AS project_key, task.number FROM task
       JOIN project ON project.id = task.project_id
       WHERE project.key = ? AND task.number = ?`,
    );
    for (const { projectKey, taskNumber } of tasks) {
      const found = taskQuery.get(projectKey, taskNumber);
      if (found !== null) {
        existingTasks.push(found);
      }
    }
  }
  return { projects, columns, tasks: existingTasks };
}

export function getById(id: string) {
  const db = getDb();
  return db
    .query<Column, Bind<Pick<Column, "id">>>(`SELECT * FROM ${DB_TABLE.projectColumn}
    WHERE id = $id`)
    .get({ $id: id });
}

export function getAllByProjectId(projectId: string) {
  const db = getDb();
  return db
    .query<Column, Bind<Pick<Column, "project_id">>>(`SELECT * FROM ${DB_TABLE.projectColumn}
    WHERE project_id = $project_id
    ORDER BY column_order`)
    .all({ $project_id: projectId });
}

export function create(column: Column) {
  const db = getDb();
  const query = db.query<Column, Bind<Column>>(`INSERT INTO
    ${DB_TABLE.projectColumn} (id, project_id, name, column_order)
    VALUES                    ($id, $project_id, $name, $column_order)
    RETURNING *;`);

  return query.get({
    $id: column.id,
    $project_id: column.project_id,
    $name: column.name,
    $column_order: column.column_order,
  });
}

export function update(props: Pick<Column, "id" | "name">) {
  return getDb()
    .query<Column, Bind<typeof props>>(`UPDATE ${DB_TABLE.projectColumn}
    SET name = $name
    WHERE id = $id
    RETURNING *;`)
    .get({ $id: props.id, $name: props.name });
}

export function updateOrder(props: Pick<Column, "id" | "column_order">) {
  return getDb()
    .query<Column, Bind<typeof props>>(`UPDATE ${DB_TABLE.projectColumn}
    SET column_order = $column_order
    WHERE id = $id
    RETURNING *;`)
    .get({ $id: props.id, $column_order: props.column_order });
}

export function deleteById(id: string) {
  return getDb()
    .query<Column, Bind<Pick<Column, "id">>>(`DELETE FROM ${DB_TABLE.projectColumn}
    WHERE id = $id RETURNING *`)
    .get({ $id: id });
}
