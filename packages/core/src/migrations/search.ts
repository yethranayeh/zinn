import type { Database } from "../sqlite/database.js";
import type { SearchEntry } from "../search-entry.js";

import { assembleSearchEntry } from "../search-entry.js";
import { TASK_SEARCH_DEFINITION } from "./baseline.js";

/**
 * Assembles the search entry of every task, archived ones included, from its task and comment records.
 * Comments are read for one task at a time, as each entry is requested.
 */
export function* readSearchEntries(db: Database): Generator<SearchEntry> {
  const tasks = db
    .query<{
      id: string;
      title: string;
      description: string | null;
    }>("SELECT id, title, description FROM task")
    .all();
  const selectComments = db.query<{ text: string }>(
    "SELECT text FROM comment WHERE task_id = $taskId ORDER BY number",
  );

  for (const task of tasks) {
    const commentTexts = selectComments.all({ $taskId: task.id }).map((comment) => comment.text);
    yield assembleSearchEntry(task, commentTexts);
  }
}

/**
 * Recreates `task_search` and fills it from every task and its comments, archived ones included.
 * Returns the number of tasks indexed.
 */
export function regenerateSearch(db: Database) {
  // A missing index is created, not refused: an older database without one could otherwise neither upgrade nor reindex.
  db.exec("DROP TABLE IF EXISTS task_search");
  db.exec(TASK_SEARCH_DEFINITION);

  const insertEntry = db.query(`INSERT INTO task_search (task_id, title, description, comments)
    VALUES ($taskId, $title, $description, $comments)`);
  let taskCount = 0;

  for (const entry of readSearchEntries(db)) {
    insertEntry.run({
      $taskId: entry.taskId,
      $title: entry.title,
      $description: entry.description,
      $comments: entry.comments,
    });
    taskCount += 1;
  }

  return taskCount;
}
