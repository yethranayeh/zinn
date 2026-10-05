import type { Database } from "../sqlite/database";

import { assembleSearchEntry } from "../search-entry";
import { TASK_SEARCH_DEFINITION } from "./baseline";

/** Recreates `task_search` and fills it from every task and its comments, archived ones included. */
export function regenerateSearch(db: Database) {
  db.exec("DROP TABLE task_search");
  db.exec(TASK_SEARCH_DEFINITION);

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
  const insertEntry = db.query(`INSERT INTO task_search (task_id, title, description, comments)
    VALUES ($taskId, $title, $description, $comments)`);

  for (const task of tasks) {
    const commentTexts = selectComments.all({ $taskId: task.id }).map((comment) => comment.text);
    const entry = assembleSearchEntry(task, commentTexts);

    insertEntry.run({
      $taskId: entry.taskId,
      $title: entry.title,
      $description: entry.description,
      $comments: entry.comments,
    });
  }
}
