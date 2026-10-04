/**
 * Reads a Zinn database the way the stress scenarios need it:
 *  - invariants that must hold after any crash or concurrent run,
 *  - per-entity snapshots, so a worker can record what it committed and the parent can check it later.
 * Every function takes the wrapper's Database, so the same code runs on a worker's getDb()
 *  connection and on the parent's own verification connection.
 */
import type { Database } from "../../packages/core/src/sqlite/database.ts";

import { openDatabase } from "../../packages/core/src/sqlite/bun.ts";

export const ZINN_TABLES = [
  "project",
  "project_column",
  "task",
  "task_relations",
  "label",
  "task_label",
  "comment",
  "task_search",
  "activity",
];

// Wait for a lock rather than fail, as Zinn does. Verification runs alone, so this rarely matters.
const VERIFY_BUSY_TIMEOUT_MS = 30_000;

// Core joins a task's comments with this separator in its search row (operations/shared.ts).
const SEARCH_COMMENT_SEPARATOR = "\n\n";

/** Opens a database for checks without creating Zinn's schema. */
export function openForChecks(path: string) {
  const db = openDatabase(path);
  db.exec(`PRAGMA busy_timeout = ${VERIFY_BUSY_TIMEOUT_MS}`);
  return db;
}

export function withDatabase<T>(path: string, check: (db: Database) => T): T {
  const db = openForChecks(path);

  try {
    return check(db);
  } finally {
    db.close();
  }
}

export type TaskSnapshot = {
  number: number;
  title: string;
  description: string | null;
  priority: string | null;
  column: string;
  order: string;
  archived: boolean;
  commentCount: number;
  labels: Array<string>;
  comments: Array<[number, string]>;
  relations: Array<string>;
};

type TaskRow = {
  number: number;
  title: string;
  description: string | null;
  priority: string | null;
  column_name: string;
  task_order: string;
  archived_at: number | null;
  comment_count: number;
};

/** A task's own fields plus its labels, comments and relations, or null when it does not exist. */
export function snapshotTask(db: Database, taskId: string): TaskSnapshot | null {
  const row = db
    .query<TaskRow, [string]>(`SELECT task.number, task.title, task.description, task.priority,
      project_column.name AS column_name, task.task_order, task.archived_at, task.comment_count
    FROM task JOIN project_column ON project_column.id = task.column_id
    WHERE task.id = ?`)
    .get(taskId);

  if (row == null) {
    return null;
  }

  const labels = db
    .query<{ label_id: string }, [string]>("SELECT label_id FROM task_label WHERE task_id = ? ORDER BY label_id")
    .all(taskId)
    .map((label) => label.label_id);
  const comments = db
    .query<{ number: number; text: string }, [string]>("SELECT number, text FROM comment WHERE task_id = ? ORDER BY number")
    .all(taskId)
    .map((comment): [number, string] => [comment.number, comment.text]);
  const relations = db
    .query<{ relation: string }, [string, string]>(`SELECT relation_type || ':' || source_task_id || '>' || target_task_id AS relation
    FROM task_relations WHERE source_task_id = ? OR target_task_id = ? ORDER BY relation`)
    .all(taskId, taskId)
    .map((relation) => relation.relation);

  return {
    number: row.number,
    title: row.title,
    description: row.description,
    priority: row.priority,
    column: row.column_name,
    order: row.task_order,
    archived: row.archived_at != null,
    commentCount: row.comment_count,
    labels,
    comments,
    relations,
  };
}

export type LabelSnapshot = { name: string; color: string; description: string | null };

export function snapshotLabel(db: Database, labelId: string): LabelSnapshot | null {
  return db
    .query<LabelSnapshot, [string]>("SELECT name, color, description FROM label WHERE id = ?")
    .get(labelId);
}

export type ProjectSnapshot = { name: string; description: string | null; taskCount: number };

export function snapshotProject(db: Database, projectKey: string): ProjectSnapshot | null {
  return db
    .query<ProjectSnapshot, [string]>(
      "SELECT name, description, task_count AS taskCount FROM project WHERE key = ?",
    )
    .get(projectKey);
}

export function sameSnapshot(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function maxActivityRowid(db: Database) {
  return db.query<{ value: number | null }>("SELECT MAX(rowid) AS value FROM activity").get()?.value ?? 0;
}

function firstValues(rows: Array<unknown>) {
  return rows.map((row) => String(Object.values(row as Record<string, unknown>)[0]));
}

/**
 * Checks that must hold for any Zinn database after a crash or a concurrent run.
 * Returns one message per violation; an empty list means the database passed.
 */
export function checkZinnInvariants(db: Database): Array<string> {
  const problems: Array<string> = [];

  const integrity = firstValues(db.query("PRAGMA integrity_check").all());
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    problems.push(`integrity_check: ${integrity.slice(0, 5).join("; ")}`);
  }

  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    problems.push(`foreign_key_check: ${foreignKeyViolations.length} violation(s), first ${JSON.stringify(foreignKeyViolations[0])}`);
  }

  const tables = new Set(firstValues(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()));
  const missingTables = ZINN_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    problems.push(`missing tables: ${missingTables.join(", ")}`);
    // The remaining checks query these tables.
    return problems;
  }

  const duplicateNumbers = db
    .query<{ project_id: string; number: number; count: number }>(`SELECT project_id, number, COUNT(*) AS count
    FROM task GROUP BY project_id, number HAVING COUNT(*) > 1`)
    .all();
  for (const duplicate of duplicateNumbers) {
    problems.push(`duplicate task number ${duplicate.number} (${duplicate.count} tasks) in project ${duplicate.project_id}`);
  }

  problems.push(...checkTaskCounters(db));
  problems.push(...checkCommentCounters(db));
  problems.push(...checkSearchRecords(db));
  problems.push(...checkActivityReferences(db));

  const sharedOrders = db
    .query<{ column_id: string; task_order: string; count: number }>(`SELECT column_id, task_order, COUNT(*) AS count
    FROM task WHERE archived_at IS NULL GROUP BY column_id, task_order HAVING COUNT(*) > 1`)
    .all();
  for (const shared of sharedOrders) {
    problems.push(`${shared.count} active tasks share task_order ${shared.task_order} in column ${shared.column_id}`);
  }

  const foreignColumns = db
    .query<{ id: string }>(`SELECT task.id FROM task JOIN project_column ON project_column.id = task.column_id
    WHERE project_column.project_id <> task.project_id`)
    .all();
  for (const task of foreignColumns) {
    problems.push(`task ${task.id} sits in another project's column`);
  }

  const multipleParents = db
    .query<{ source_task_id: string; count: number }>(`SELECT source_task_id, COUNT(*) AS count FROM task_relations
    WHERE relation_type = 'subtask' GROUP BY source_task_id HAVING COUNT(*) > 1`)
    .all();
  for (const child of multipleParents) {
    problems.push(`task ${child.source_task_id} has ${child.count} parents`);
  }

  return problems;
}

/**
 * task_count is a counter that never goes down, and every increment writes one task 'create' activity row
 *  in the same transaction. A deleted task's 'delete' row keeps its key, which names its project.
 * Each table is read once and joined in JS: a correlated subquery over activity per project would be quadratic.
 */
function checkTaskCounters(db: Database) {
  const problems: Array<string> = [];
  const projects = db
    .query<{ id: string; key: string; task_count: number }>("SELECT id, key, task_count FROM project")
    .all();
  const keyByProjectId = new Map(projects.map((project) => [project.id, project.key]));
  const projectKeyByTaskId = new Map<string, string>();
  const maxNumberByProjectKey = new Map<string, number>();

  for (const task of db.query<{ id: string; project_id: string; number: number }>("SELECT id, project_id, number FROM task").all()) {
    const projectKey = keyByProjectId.get(task.project_id);
    if (projectKey == null) {
      continue;
    }

    projectKeyByTaskId.set(task.id, projectKey);
    maxNumberByProjectKey.set(projectKey, Math.max(maxNumberByProjectKey.get(projectKey) ?? 0, task.number));
  }

  const deletedKeyByTaskId = new Map<string, string>();
  const createdTaskIds: Array<string> = [];
  const taskActivity = db
    .query<{ entity_id: string; action: string; task_key: string | null }>(`SELECT entity_id, action, json_extract(changes, '$.key') AS task_key
    FROM activity WHERE entity_type = 'task' AND action IN ('create', 'delete')`)
    .all();

  for (const row of taskActivity) {
    if (row.action === "create") {
      createdTaskIds.push(row.entity_id);
    } else if (row.task_key != null) {
      deletedKeyByTaskId.set(row.entity_id, row.task_key);
    }
  }

  const createdByProjectKey = new Map<string, number>();
  for (const taskId of createdTaskIds) {
    const deletedKey = deletedKeyByTaskId.get(taskId);
    const projectKey = projectKeyByTaskId.get(taskId) ?? deletedKey?.slice(0, deletedKey.lastIndexOf("-"));
    if (projectKey != null) {
      createdByProjectKey.set(projectKey, (createdByProjectKey.get(projectKey) ?? 0) + 1);
    }
  }

  for (const project of projects) {
    const maxNumber = maxNumberByProjectKey.get(project.key);
    const created = createdByProjectKey.get(project.key) ?? 0;

    if (maxNumber != null && project.task_count < maxNumber) {
      problems.push(`project ${project.key}: task_count ${project.task_count} is below its highest task number ${maxNumber}`);
    }
    if (project.task_count !== created) {
      problems.push(`project ${project.key}: task_count ${project.task_count} but ${created} task create activity rows`);
    }
  }

  return problems;
}

/** comment_count works the same way, with one 'comment_create' row per increment. */
function checkCommentCounters(db: Database) {
  const problems: Array<string> = [];
  const maxNumberByTaskId = new Map(
    db
      .query<{ task_id: string; max_number: number }>("SELECT task_id, MAX(number) AS max_number FROM comment GROUP BY task_id")
      .all()
      .map((row) => [row.task_id, row.max_number]),
  );
  const createdByTaskId = new Map(
    db
      .query<{ entity_id: string; created: number }>(`SELECT entity_id, COUNT(*) AS created FROM activity
      WHERE entity_type = 'task' AND action = 'comment_create' GROUP BY entity_id`)
      .all()
      .map((row) => [row.entity_id, row.created]),
  );

  for (const task of db.query<{ id: string; comment_count: number }>("SELECT id, comment_count FROM task").all()) {
    const maxNumber = maxNumberByTaskId.get(task.id);
    const created = createdByTaskId.get(task.id) ?? 0;

    if (maxNumber != null && task.comment_count < maxNumber) {
      problems.push(`task ${task.id}: comment_count ${task.comment_count} is below its highest comment number ${maxNumber}`);
    }
    if (task.comment_count !== created) {
      problems.push(`task ${task.id}: comment_count ${task.comment_count} but ${created} comment_create activity rows`);
    }
  }

  return problems;
}

/** Search rows have no trigger behind them: core rewrites them in the same transaction as the task. */
function checkSearchRecords(db: Database) {
  const problems: Array<string> = [];
  const searchRows = db
    .query<{ task_id: string; title: string; description: string | null; comments: string }>(
      "SELECT task_id, title, description, comments FROM task_search",
    )
    .all();
  const rowsByTask = new Map<string, Array<(typeof searchRows)[number]>>();

  for (const row of searchRows) {
    rowsByTask.set(row.task_id, [...(rowsByTask.get(row.task_id) ?? []), row]);
  }

  const tasks = db
    .query<{ id: string; title: string; description: string | null }>("SELECT id, title, description FROM task")
    .all();
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    const rows = rowsByTask.get(task.id) ?? [];
    if (rows.length !== 1) {
      problems.push(`task ${task.id} has ${rows.length} search rows`);
      continue;
    }

    const comments = db
      .query<{ text: string }, [string]>("SELECT text FROM comment WHERE task_id = ? ORDER BY number")
      .all(task.id)
      .map((comment) => comment.text)
      .join(SEARCH_COMMENT_SEPARATOR);
    const row = rows[0]!;
    const matches = row.title === task.title && row.description === task.description && row.comments === comments;

    if (!matches) {
      problems.push(`task ${task.id}: search row does not match its title, description and comments`);
    }
  }

  for (const taskId of rowsByTask.keys()) {
    if (!taskIds.has(taskId)) {
      problems.push(`search row for missing task ${taskId}`);
    }
  }

  return problems;
}

/**
 * Activity rows are never deleted. An entity that has activity but no row must have a 'delete' row,
 *  and every existing task and label must have exactly one 'create' row.
 */
function checkActivityReferences(db: Database) {
  const problems: Array<string> = [];
  const actionCounts = db
    .query<{ entity_type: string; entity_id: string; action: string; count: number }>(`SELECT entity_type, entity_id, action, COUNT(*) AS count
    FROM activity WHERE entity_type IN ('task', 'label', 'project') GROUP BY entity_type, entity_id, action`)
    .all();

  for (const entity of [
    { type: "task", table: "task" },
    { type: "label", table: "label" },
    { type: "project", table: "project" },
  ]) {
    const existingIds = new Set(firstValues(db.query(`SELECT id FROM ${entity.table}`).all()));
    const activityIds = new Set<string>();
    const deletedIds = new Set<string>();
    const createCounts = new Map<string, number>();

    for (const row of actionCounts) {
      if (row.entity_type !== entity.type) {
        continue;
      }

      activityIds.add(row.entity_id);
      if (row.action === "delete") {
        deletedIds.add(row.entity_id);
      } else if (row.action === "create") {
        createCounts.set(row.entity_id, row.count);
      }
    }

    for (const id of activityIds) {
      if (!existingIds.has(id) && !deletedIds.has(id)) {
        problems.push(`${entity.type} ${id} has activity but neither a row nor a delete record`);
      }
    }

    for (const id of existingIds) {
      const count = createCounts.get(id) ?? 0;
      if (count !== 1) {
        problems.push(`${entity.type} ${id} has ${count} create activity rows`);
      }
    }
  }

  return problems;
}
