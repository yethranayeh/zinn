import type { Bind, Task } from "../types";

import { getDb } from "../db";
import { DB_TABLE } from "../constant";

export type TaskArchiveFilter = "active" | "archived" | "all";

function getArchiveCondition(filter: TaskArchiveFilter) {
  switch (filter) {
    case "active":
      return `${DB_TABLE.task}.archived_at IS NULL`;
    case "archived":
      return `${DB_TABLE.task}.archived_at IS NOT NULL`;
    case "all":
      return null;
  }
}

// TODO: refined parameters, preferably of type SQLBindings
export function getAll(archive: TaskArchiveFilter = "active") {
  const db = getDb();
  const archiveCondition = getArchiveCondition(archive);
  const whereClause = archiveCondition == null ? "" : `WHERE ${archiveCondition}`;

  return db
    .query<Task, any>(`SELECT * FROM ${DB_TABLE.task}
    ${whereClause}
    ORDER BY (${DB_TABLE.task}.archived_at IS NOT NULL) ASC`)
    .all();
}

export function getAllByProjectId(projectId: string, archive: TaskArchiveFilter = "active") {
  const db = getDb();
  const archiveCondition = getArchiveCondition(archive);
  const archiveCluase = archiveCondition == null ? "" : `AND ${archiveCondition}`;

  return db
    .query<Task, Bind<Pick<Task, "project_id">>>(`SELECT task.*
    FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.projectColumn}
      ON project_column.id = task.column_id
    WHERE task.project_id = $project_id
      ${archiveCluase}
    ORDER BY project_column.column_order ASC,
      (task.archived_at IS NOT NULL) ASC,
      task.task_order ASC,
      task.number ASC`)
    .all({ $project_id: projectId });
}

export function getAllByColumnId(columnId: string, archive: TaskArchiveFilter = "active") {
  const db = getDb();
  const archiveCondition = getArchiveCondition(archive);
  const archiveClause = archiveCondition == null ? "" : `AND ${archiveCondition}`;

  return db
    .query<Task, Bind<Pick<Task, "column_id">>>(`SELECT *
    FROM ${DB_TABLE.task}
    WHERE column_id = $column_id
      ${archiveClause}
    ORDER BY task_order ASC,
      number ASC`)
    .all({ $column_id: columnId });
}

export function getLastByColumnId(columnId: string) {
  const db = getDb();
  return db
    .query<Task, Bind<Pick<Task, "column_id">>>(`SELECT *
    FROM ${DB_TABLE.task}
    WHERE column_id = $column_id
      AND archived_at IS NULL
    ORDER BY task_order DESC
    LIMIT 1`)
    .get({ $column_id: columnId });
}

export function getByProjectIdAndNumber(props: { projectId: string; number: number }) {
  const db = getDb();
  return db
    .query<Task, Bind<Pick<Task, "project_id" | "number">>>(`SELECT *
    FROM ${DB_TABLE.task}
    WHERE project_id = $project_id
    AND number = $number`)
    .get({ $project_id: props.projectId, $number: props.number });
}

export function create(task: Omit<Task, "archived_at">) {
  const db = getDb();

  const q = db.query<Task, Bind<Omit<Task, "archived_at">>>(`INSERT INTO
    ${DB_TABLE.task}  (id, project_id, column_id, number, title, description, task_order, created_at, updated_at)
    VALUES            ($id, $project_id, $column_id, $number, $title, $description, $task_order, $created_at, $updated_at);`);

  q.run({
    $id: task.id,
    $project_id: task.project_id,
    $column_id: task.column_id,
    $number: task.number,
    $title: task.title,
    $description: task.description,
    $task_order: task.task_order,
    $created_at: task.created_at,
    $updated_at: task.updated_at,
  });

  return { ...task, archived_at: null };
}

const TASK_UPDATE_COLUMNS = [
  "column_id",
  "title",
  "description",
  "task_order",
  "updated_at",
  "archived_at",
] as const satisfies ReadonlyArray<keyof Task>;

type TaskUpdateColumn = (typeof TASK_UPDATE_COLUMNS)[number];
type TaskUpdateParams = Pick<Task, "id" | "updated_at"> &
  Partial<Pick<Task, Exclude<TaskUpdateColumn, "updated_at">>>;
type TaskUpdateBindings = Record<string, Task[keyof Task]>;

export function update(props: TaskUpdateParams) {
  const db = getDb();

  const setClauses: Array<string> = [];
  const bindings: TaskUpdateBindings = { $id: props.id };

  for (const column of TASK_UPDATE_COLUMNS) {
    const value = props[column];
    if (value === undefined) {
      continue;
    }

    setClauses.push(`${column} = $${column}`);
    bindings[`$${column}`] = value;
  }

  return db
    .prepare<Task, TaskUpdateBindings>(`UPDATE ${DB_TABLE.task}
    SET ${setClauses.join(",\n        ")}
    WHERE id = $id
    RETURNING *;`)
    .get(bindings);
}

export function deleteById(taskId: string) {
  const db = getDb();

  return db
    .query<never, Bind<Pick<Task, "id">>>(`DELETE FROM ${DB_TABLE.task} WHERE id = $id;`)
    .run({ $id: taskId });
}
