import type { Bind, Task } from "../types.js";
import type { TaskArchiveFilter, TaskListInput, TaskStateFilter } from "../schemas/task.js";

export type { TaskArchiveFilter } from "../schemas/task.js";

import { getDb } from "../db.js";
import { taskPrioritySchema } from "../schemas/task.js";
import { CLOSED_COLUMN_CATEGORIES, READY_COLUMN_CATEGORIES } from "../schemas/column.js";
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
// `task.id` comes last so tasks that tie on every other key still have one order
const BOARD_ORDER_KEYS = [
  "project_key",
  "column_order_null_rank",
  "column_order",
  "archive_rank",
  "task_order_null_rank",
  "task_order",
  "number",
  "id",
] as const;
const DUE_ORDER_KEYS = ["due_null_rank", "due_value", ...BOARD_ORDER_KEYS] as const;
const ACTIVITY_ORDER_KEYS = ["activity_time", ...BOARD_ORDER_KEYS] as const;
const DESCENDING_SORT_KEY = "activity_time";

export type TaskSortKey = (typeof DUE_ORDER_KEYS)[number] | (typeof ACTIVITY_ORDER_KEYS)[number];
/** Sort-key values of one task, in getTaskSortKeys order. */
export type TaskSortPosition = Array<string | number>;

export function getById(taskId: string) {
  return getDb().query<Task, [string]>(`SELECT * FROM ${DB_TABLE.task} WHERE id = ?`).get(taskId);
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
  "archive" | "state" | "dueSince" | "dueUntil" | "limit" | "sort"
> & {
  projectId?: string;
  labelIds?: Array<string>;
  columnIds?: Array<string>;
};

export type TaskPageQuery = TaskListQuery & { after?: TaskSortPosition };
export type TaskListRow = Task & { project_key: string };
export type TaskPageRow = { task: TaskListRow; position: TaskSortPosition };

function buildTaskListFilters(input: TaskListQuery) {
  const predicates: Array<string> = [];
  const bindings: Record<string, string | number> = {};
  const archiveCondition = getArchiveCondition(input.archive ?? "active");

  if (archiveCondition != null) {
    predicates.push(archiveCondition);
  }

  const stateCondition = input.state === undefined ? null : getStateCondition(input.state);

  if (stateCondition != null) {
    predicates.push(stateCondition);
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

/** The keys that order a task list under one sort, so list order, cursors and pages agree */
export function getTaskSortKeys(sort: TaskListQuery["sort"]): ReadonlyArray<TaskSortKey> {
  if (sort === "due") {
    return DUE_ORDER_KEYS;
  }

  if (sort === "activity") {
    return ACTIVITY_ORDER_KEYS;
  }

  return BOARD_ORDER_KEYS;
}

/** Orders `ordered_tasks` rows for every task list, so the first page and later pages agree */
function getListOrder(sort: TaskListQuery["sort"], alias: string) {
  return getTaskSortKeys(sort)
    .map((key) => `${alias}.${key} ${key === DESCENDING_SORT_KEY ? "DESC" : "ASC"}`)
    .join(", ");
}

/** Selects rows after the $after_<key> position, matching getListOrder. */
function getPageAfterCondition(sort: TaskListQuery["sort"]) {
  const boardCurrent = `(${BOARD_ORDER_KEYS.map((key) => `current.${key}`).join(", ")})`;
  const boardAfter = `(${BOARD_ORDER_KEYS.map((key) => `$after_${key}`).join(", ")})`;

  if (sort === "activity") {
    return `current.activity_time < $after_activity_time
      OR (current.activity_time = $after_activity_time AND ${boardCurrent} > ${boardAfter})`;
  }

  const keys = getTaskSortKeys(sort);
  const current = `(${keys.map((key) => `current.${key}`).join(", ")})`;
  const after = `(${keys.map((key) => `$after_${key}`).join(", ")})`;

  return `${current} > ${after}`;
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

/**
 * Whether the column table has categories.
 * Older schemas do not have them, so they are readolny
 */
function hasColumnCategory() {
  return (
    getDb()
      .query<{ found: number }, []>(
        `SELECT 1 AS found FROM pragma_table_info('${DB_TABLE.projectColumn}') WHERE name = 'category'`,
      )
      .get() != null
  );
}

/** Quotes fixed vocabulary values, never user input, as an SQL list such as `'done', 'cancelled'`. */
function toSqlTextList(values: ReadonlyArray<string>) {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * SQL condition: the task under `alias` is in a done or cancelled column.
 * Older schemas without categories count the last column of the task's own board as closed.
 *  There, `ORDER BY ... LIMIT 1` still finds a column when every column_order is NULL.
 */
function getClosedColumnCondition(alias: string, hasCategories: boolean) {
  if (hasCategories) {
    return `${alias}.column_id IN (
        SELECT closed_column.id
        FROM ${DB_TABLE.projectColumn} AS closed_column
        WHERE closed_column.category IN (${toSqlTextList(CLOSED_COLUMN_CATEGORIES)})
      )`;
  }

  return `${alias}.column_id IS (
        SELECT last_column.id
        FROM ${DB_TABLE.projectColumn} AS last_column
        WHERE last_column.project_id = ${alias}.project_id
        ORDER BY last_column.column_order DESC
        LIMIT 1
      )`;
}

/** SQL condition: the task under `alias` is open work, meaning active and not in a closed column. */
function getOpenWorkCondition(alias: string, hasCategories: boolean) {
  return `${alias}.archived_at IS NULL
      AND NOT ${getClosedColumnCondition(alias, hasCategories)}`;
}

/** SQL condition for a task-list state filter, or `null` when every state matches. */
function getStateCondition(filter: TaskStateFilter) {
  if (filter === "all") {
    return null;
  }

  const closedCondition = getClosedColumnCondition("task", hasColumnCategory());
  return filter === "closed" ? closedCondition : `NOT ${closedCondition}`;
}

/** SQL condition: the task under `alias` depends on at least one task that is open work. */
function getOpenDependencyCondition(alias: string, hasCategories: boolean) {
  return `EXISTS (
      SELECT 1
      FROM ${DB_TABLE.task_relations} AS dependency
      INNER JOIN ${DB_TABLE.task} AS dependency_target
        ON dependency_target.id = dependency.target_task_id
      WHERE dependency.source_task_id = ${alias}.id
        AND dependency.relation_type = 'dependency'
        AND ${getOpenWorkCondition("dependency_target", hasCategories)}
    )`;
}

// Highest priority first, unset last
const PRIORITY_RANK_SQL = `CASE task.priority
        ${[...taskPrioritySchema.options]
          .reverse()
          .map((priority, rank) => `WHEN '${priority}' THEN ${rank}`)
          .join("\n        ")}
        ELSE ${taskPrioritySchema.options.length}
      END`;

export type TaskNextQuery = { projectId?: string; columnIds?: Array<string> };

// Older schemas, still readable read-only, have no `due_at` column and so no deadlines to order by.
function hasDeadlineColumn() {
  return (
    getDb()
      .query<{ found: number }, []>(
        `SELECT 1 AS found FROM pragma_table_info('${DB_TABLE.task}') WHERE name = 'due_at'`,
      )
      .get() != null
  );
}

// Ready categories in their preferred order, any other category after them
const READY_CATEGORY_RANK_SQL = `CASE task_column.category
        ${READY_COLUMN_CATEGORIES.map((category, rank) => `WHEN '${category}' THEN ${rank}`).join("\n        ")}
        ELSE ${READY_COLUMN_CATEGORIES.length}
      END`;

/**
 * Returns the first ready task: open work with no open dependency, in a todo or backlog column
 *  unless `columnIds` names the columns. Orders todo before backlog, then by priority, then the
 *  earliest deadline with undated tasks last, then creation.
 * Older schemas without categories have no todo or backlog, so every open task is ready there.
 */
export function getNext(input: TaskNextQuery) {
  const hasCategories = hasColumnCategory();
  const predicates = [
    getOpenWorkCondition("task", hasCategories),
    `NOT ${getOpenDependencyCondition("task", hasCategories)}`,
  ];
  const bindings: Record<string, string> = {};

  if (hasCategories && input.columnIds === undefined) {
    predicates.push(`task_column.category IN (${toSqlTextList(READY_COLUMN_CATEGORIES)})`);
  }

  if (input.projectId !== undefined) {
    predicates.push("task.project_id = $project_id");
    bindings.$project_id = input.projectId;
  }

  if (input.columnIds !== undefined) {
    predicates.push("task.column_id IN (SELECT value FROM json_each($columnIds))");
    bindings.$columnIds = JSON.stringify(input.columnIds);
  }

  const categoryOrder = hasCategories ? `${READY_CATEGORY_RANK_SQL},\n      ` : "";
  const deadlineOrder = hasDeadlineColumn()
    ? `
      (task.due_at IS NULL) ASC,
      task.due_at ASC,`
    : "";

  return getDb()
    .query<TaskListRow, Record<string, string>>(`SELECT task.*, project.key AS project_key
    FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.project}
      ON project.id = task.project_id
    INNER JOIN ${DB_TABLE.projectColumn} AS task_column
      ON task_column.id = task.column_id
    WHERE ${predicates.join("\n      AND ")}
    ORDER BY ${categoryOrder}${PRIORITY_RANK_SQL},${deadlineOrder}
      task.created_at ASC,
      project.key ASC,
      task.number ASC
    LIMIT 1`)
    .get(bindings);
}

/** Returns the existing tasks, active and archived, with any of the given IDs. */
export function getAllByIds(taskIds: Array<string>) {
  return getDb()
    .query<TaskListRow, { $taskIds: string }>(`SELECT task.*, project.key AS project_key
    FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.project}
      ON project.id = task.project_id
    WHERE task.id IN (SELECT value FROM json_each($taskIds))
    ORDER BY project.key ASC, task.number ASC`)
    .all({ $taskIds: JSON.stringify(taskIds) });
}

/** Returns the existing tasks, active and archived, with any of the given `PROJECT-1` keys. */
export function getAllByKeys(taskKeys: Array<string>) {
  // One pass over task: no index covers (project_id, number), so a per-key join would rescan it.
  return getDb()
    .query<TaskListRow, { $taskKeys: string }>(`SELECT task.*, project.key AS project_key
    FROM ${DB_TABLE.task}
    INNER JOIN ${DB_TABLE.project}
      ON project.id = task.project_id
    WHERE project.key || '-' || task.number IN (SELECT value FROM json_each($taskKeys))
    ORDER BY project.key ASC, task.number ASC`)
    .all({ $taskKeys: JSON.stringify(taskKeys) });
}

/** Returns one bounded task page, after a sort position when given, with each row's position */
export function getPage(input: TaskPageQuery): Array<TaskPageRow> {
  const keys = getTaskSortKeys(input.sort);
  const { where, limit, bindings } = buildTaskListFilters(input);
  const after = input.after;
  let afterClause = "";

  if (after !== undefined) {
    afterClause = `WHERE ${getPageAfterCondition(input.sort)}`;
    keys.forEach((key, index) => {
      bindings[`$after_${key}`] = after[index]!;
    });
  }

  const rows = getDb()
    .query<
      TaskListRow & Record<string, string | number | null>,
      Record<string, string | number>
    >(`WITH ${getOrderedTasksCtes(input.sort, where)}, page_ids AS (
      SELECT current.*
      FROM ordered_tasks AS current
      ${afterClause}
      ORDER BY ${getListOrder(input.sort, "current")}
      ${limit}
    )
    SELECT task.*, page_ids.project_key, ${keys.map((key) => `page_ids.${key} AS cursor_${key}`).join(", ")}
    FROM page_ids
    INNER JOIN ${DB_TABLE.task}
      ON task.id = page_ids.id
    ORDER BY ${getListOrder(input.sort, "page_ids")}`)
    .all(bindings);

  return rows.map((row) => {
    const position = keys.map((key) => row[`cursor_${key}`] as string | number);
    const taskRow: Record<string, unknown> = { ...row };

    for (const key of keys) {
      delete taskRow[`cursor_${key}`];
    }

    return { task: taskRow as TaskListRow, position };
  });
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
