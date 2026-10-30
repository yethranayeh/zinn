import type { Bind, Task } from "../types.js";
import type { TaskArchiveFilter, TaskListInput } from "../schemas/task.js";

export type { TaskArchiveFilter } from "../schemas/task.js";

import { getDb } from "../db.js";
import { DB_TABLE } from "../constant.js";

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

/** JS-side equivalent of getArchiveCondition, for rows already fetched (e.g. a pinned exact-key match). */
export function matchesArchiveFilter(task: Pick<Task, "archived_at">, filter: TaskArchiveFilter) {
  switch (filter) {
    case "active":
      return task.archived_at == null;
    case "archived":
      return task.archived_at != null;
    case "all":
      return true;
  }
}

const PROJECT_TASK_ORDER = `project_column.column_order ASC,
      (task.archived_at IS NOT NULL) ASC,
      task.task_order ASC,
      task.number ASC`;
const GLOBAL_TASK_ORDER = `project.key ASC,
      ${PROJECT_TASK_ORDER}`;
const TASK_LIST_FROM = `FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.project}
      ON project.id = task.project_id
    INNER JOIN ${DB_TABLE.projectColumn}
      ON project_column.id = task.column_id`;
const TASK_ACTIVITY_CTE = `task_activity AS (
      SELECT entity_id, MAX(created_at) AS created_at
      FROM ${DB_TABLE.activity}
      WHERE entity_type = 'task'
        AND entity_id IN (SELECT id FROM candidate_tasks)
      GROUP BY entity_id
    )`;
const TASK_LAST_ACTIVITY_TIME_SQL = "COALESCE(task_activity.created_at, task.updated_at)";
const BOARD_ORDER_KEYS = [
  "project_key",
  "column_order_null_rank",
  "column_order",
  "archive_rank",
  "task_order_null_rank",
  "task_order",
  "number",
];

export function getById(taskId: string) {
  return getDb().query<Task, [string]>(`SELECT * FROM ${DB_TABLE.task} WHERE id = ?`).get(taskId);
}

/** Returns all live task IDs matching a normalized UUID prefix. */
export function getByIdPrefix(hexPrefix: string) {
  return getDb()
    .query<{ id: string }, [string]>(
      `SELECT id FROM ${DB_TABLE.task}
      WHERE LOWER(REPLACE(id, '-', '')) LIKE ?
      ORDER BY id ASC`,
    )
    .all(`${hexPrefix}%`);
}

// TODO: refined parameters, preferably of type SQLBindings
export function getAll(archive: TaskArchiveFilter = "active") {
  const db = getDb();
  const archiveCondition = getArchiveCondition(archive);
  const whereClause = archiveCondition == null ? "" : `WHERE ${archiveCondition}`;

  return db
    .query<Task, any>(`SELECT task.*
    FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.project}
      ON project.id = task.project_id
    INNER JOIN ${DB_TABLE.projectColumn}
      ON project_column.id = task.column_id
    ${whereClause}
    ORDER BY ${GLOBAL_TASK_ORDER}`)
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
    ORDER BY ${PROJECT_TASK_ORDER}`)
    .all({ $project_id: projectId });
}

export type TaskListQuery = Pick<
  TaskListInput,
  "archive" | "dueSince" | "dueUntil" | "limit" | "sort"
> & {
  projectId?: string;
  labelIds?: Array<string>;
  columnIds?: Array<string>;
};

export type TaskPageQuery = TaskListQuery & { afterTaskId: string };

export type TaskListRow = Task & { project_key: string };

type TaskPageRow = { cursor_in_selection: number } & {
  [Key in keyof TaskListRow]: TaskListRow[Key] | null;
};

export type TaskPageMatches = { cursorInSelection: boolean; tasks: Array<TaskListRow> };

function buildTaskListFilters(input: TaskListQuery) {
  const predicates: Array<string> = [];
  const bindings: Record<string, string | number> = {};
  const archiveCondition = getArchiveCondition(input.archive ?? "active");

  if (archiveCondition != null) {
    predicates.push(archiveCondition);
  }

  if (input.projectId !== undefined) {
    predicates.push("task.project_id = $project_id");
    bindings.$project_id = input.projectId;
  }

  for (const [index, labelId] of (input.labelIds ?? []).entries()) {
    const bindingName = `$label_id_${index}`;
    predicates.push(`EXISTS (
      SELECT 1 FROM ${DB_TABLE.taskLabel}
      WHERE ${DB_TABLE.taskLabel}.task_id = task.id
        AND ${DB_TABLE.taskLabel}.label_id = ${bindingName}
    )`);
    bindings[bindingName] = labelId;
  }

  if (input.columnIds !== undefined) {
    if (input.columnIds.length === 0) {
      predicates.push("1 = 0");
    } else {
      predicates.push("task.column_id IN (SELECT value FROM json_each($columnIds))");
      bindings.$columnIds = JSON.stringify(input.columnIds);
    }
  }

  if (input.dueSince !== undefined) {
    predicates.push("task.due_at IS NOT NULL AND task.due_at >= $dueSince");
    bindings.$dueSince = input.dueSince;
  }

  if (input.dueUntil !== undefined) {
    predicates.push("task.due_at IS NOT NULL AND task.due_at <= $dueUntil");
    bindings.$dueUntil = input.dueUntil;
  }

  const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
  const limit = input.limit === undefined ? "" : "LIMIT $limit";

  if (input.limit !== undefined) {
    bindings.$limit = input.limit;
  }

  return { where, limit, bindings };
}

function getCandidateTasksCte(where: string) {
  return `candidate_tasks AS (
      SELECT task.id
      ${TASK_LIST_FROM}
      ${where}
    )`;
}

/** Orders ordered_tasks rows for every task list, so the first page and later pages agree. */
function getListOrder(sort: TaskListQuery["sort"], alias: string) {
  const boardOrder = BOARD_ORDER_KEYS.map((key) => `${alias}.${key} ASC`).join(", ");

  if (sort === "due") {
    return `${alias}.due_null_rank ASC, ${alias}.due_value ASC, ${boardOrder}`;
  }

  if (sort === "activity") {
    return `${alias}.activity_time DESC, ${boardOrder}`;
  }

  return boardOrder;
}

function getPageAfterCondition(sort: TaskListQuery["sort"]) {
  const boardCurrent = `(${BOARD_ORDER_KEYS.map((key) => `current.${key}`).join(", ")})`;
  const boardAnchor = `(${BOARD_ORDER_KEYS.map((key) => `anchor.${key}`).join(", ")})`;

  if (sort === "due") {
    const current = `(current.due_null_rank, current.due_value, ${BOARD_ORDER_KEYS.map((key) => `current.${key}`).join(", ")})`;
    const anchor = `(anchor.due_null_rank, anchor.due_value, ${BOARD_ORDER_KEYS.map((key) => `anchor.${key}`).join(", ")})`;
    return `${current} > ${anchor}`;
  }

  if (sort === "activity") {
    return `current.activity_time < anchor.activity_time
      OR (current.activity_time = anchor.activity_time AND ${boardCurrent} > ${boardAnchor})`;
  }

  return `${boardCurrent} > ${boardAnchor}`;
}

function getOrderedTasksCtes(sort: TaskListQuery["sort"], where: string) {
  const ctes = [getCandidateTasksCte(where)];
  const activityJoin =
    sort === "activity"
      ? `LEFT JOIN task_activity
        ON task_activity.entity_id = task.id`
      : "";
  const activityTime =
    sort === "activity" ? `, ${TASK_LAST_ACTIVITY_TIME_SQL} AS activity_time` : "";
  // Only the due sort reads due_at, so other sorts also work on older schemas without it.
  const dueKeys =
    sort === "due"
      ? `,
        (task.due_at IS NULL) AS due_null_rank,
        COALESCE(task.due_at, 0) AS due_value`
      : "";

  if (sort === "activity") {
    ctes.push(TASK_ACTIVITY_CTE);
  }

  ctes.push(`ordered_tasks AS (
      SELECT task.id,
        project.key AS project_key,
        (project_column.column_order IS NOT NULL) AS column_order_null_rank,
        COALESCE(project_column.column_order, '') AS column_order,
        (task.archived_at IS NOT NULL) AS archive_rank,
        (task.task_order IS NOT NULL) AS task_order_null_rank,
        COALESCE(task.task_order, '') AS task_order,
        task.number AS number${dueKeys}${activityTime}
      ${TASK_LIST_FROM}
      INNER JOIN candidate_tasks
        ON candidate_tasks.id = task.id
      ${activityJoin}
    )`);

  return ctes.join(",\n");
}

/** Returns task-list rows after applying core-resolved filters, ordering and limit. */
export function getList(input: TaskListQuery) {
  const { where, limit, bindings } = buildTaskListFilters(input);

  return getDb()
    .query<
      TaskListRow,
      Record<string, string | number>
    >(`WITH ${getOrderedTasksCtes(input.sort, where)}
    SELECT task.*, current.project_key
    FROM ordered_tasks AS current
    INNER JOIN ${DB_TABLE.task}
      ON task.id = current.id
    ORDER BY ${getListOrder(input.sort, "current")}
    ${limit}`)
    .all(bindings);
}

/** Returns one bounded task page and whether the live cursor matches the list filters. */
export function getPageAfter(input: TaskPageQuery): TaskPageMatches {
  const { where, limit, bindings } = buildTaskListFilters(input);
  const pageOrder = getListOrder(input.sort, "page_ids");
  const afterCondition = getPageAfterCondition(input.sort);
  bindings.$afterTaskId = input.afterTaskId;

  const rows = getDb()
    .query<
      TaskPageRow,
      Record<string, string | number>
    >(`WITH ${getOrderedTasksCtes(input.sort, where)}, cursor_state AS (
      SELECT EXISTS (
        SELECT 1 FROM ordered_tasks WHERE id = $afterTaskId
      ) AS cursor_in_selection
    ), page_ids AS (
      SELECT current.*
      FROM ordered_tasks AS current
      INNER JOIN ordered_tasks AS anchor
        ON anchor.id = $afterTaskId
      WHERE ${afterCondition}
      ORDER BY ${getListOrder(input.sort, "current")}
      ${limit}
    )
    SELECT cursor_state.cursor_in_selection, task.*, page_ids.project_key
    FROM cursor_state
    LEFT JOIN page_ids
      ON 1 = 1
    LEFT JOIN ${DB_TABLE.task}
      ON task.id = page_ids.id
    ORDER BY ${pageOrder}`)
    .all(bindings);

  const cursorInSelection = rows[0]?.cursor_in_selection === 1;
  const tasks: Array<TaskListRow> = [];

  for (const { cursor_in_selection, ...taskRow } of rows) {
    if (cursor_in_selection === 1 && taskRow.id !== null) {
      tasks.push(taskRow as TaskListRow);
    }
  }

  return { cursorInSelection, tasks };
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

/** Counts existing tasks across all projects without loading their contents. */
export function countByProjectId() {
  return getDb()
    .query<{ project_id: string; active: number; archived: number }, []>(`SELECT project_id,
      SUM(CASE WHEN ${getArchiveCondition("active")} THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN ${getArchiveCondition("archived")} THEN 1 ELSE 0 END) AS archived
    FROM ${DB_TABLE.task}
    GROUP BY project_id`)
    .all();
}

/** One row per column that has matching tasks. Columns without any matches are left out. */
export function countByColumnId(projectId: string, archive: TaskArchiveFilter = "active") {
  const db = getDb();
  const archiveCondition = getArchiveCondition(archive);
  const archiveClause = archiveCondition == null ? "" : `AND ${archiveCondition}`;

  return db
    .query<
      { column_id: string; task_count: number },
      Bind<Pick<Task, "project_id">>
    >(`SELECT column_id, COUNT(*) AS task_count
    FROM ${DB_TABLE.task}
    WHERE project_id = $project_id
      ${archiveClause}
    GROUP BY column_id`)
    .all({ $project_id: projectId });
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

export function create(task: Omit<Task, "archived_at" | "comment_count">) {
  const db = getDb();

  const q = db.query<Task, Bind<Omit<Task, "archived_at" | "comment_count">>>(`INSERT INTO
    ${DB_TABLE.task}  (id, project_id, column_id, number, title, description, priority, due_at, task_order, created_at, updated_at)
    VALUES            ($id, $project_id, $column_id, $number, $title, $description, $priority, $due_at, $task_order, $created_at, $updated_at);`);

  q.run({
    $id: task.id,
    $project_id: task.project_id,
    $column_id: task.column_id,
    $number: task.number,
    $title: task.title,
    $description: task.description,
    $priority: task.priority,
    $due_at: task.due_at,
    $task_order: task.task_order,
    $created_at: task.created_at,
    $updated_at: task.updated_at,
  });

  return { ...task, comment_count: 0, archived_at: null };
}

const TASK_UPDATE_COLUMNS = [
  "column_id",
  "title",
  "description",
  "priority",
  "due_at",
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
    .query<Task, TaskUpdateBindings>(`UPDATE ${DB_TABLE.task}
    SET ${setClauses.join(",\n        ")}
    WHERE id = $id
    RETURNING *;`)
    .get(bindings);
}

export function deleteById(taskId: string) {
  const db = getDb();

  db.query<never, Bind<Pick<Task, "id">>>(`DELETE FROM ${DB_TABLE.task} WHERE id = $id;`).run({
    $id: taskId,
  });
}

export function incrementCommentCounterById(taskId: string) {
  return getDb()
    .query<{ comment_count: number }, Bind<{ taskId: string }>>(`UPDATE ${DB_TABLE.task}
    SET comment_count = comment_count + 1
    WHERE id = $taskId
    RETURNING comment_count`)
    .get({ $taskId: taskId });
}

export function updateLabelTasksTimestamp(labelId: string, updatedAt: number) {
  getDb()
    .query(`UPDATE ${DB_TABLE.task} SET updated_at = ? WHERE id IN
    (SELECT task_id FROM ${DB_TABLE.taskLabel} WHERE label_id = ?)`)
    .run(updatedAt, labelId);
}
