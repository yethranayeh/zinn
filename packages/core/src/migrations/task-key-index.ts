import type { Migration } from "./registry.js";
import { CoreError } from "../errors.js";

/** The schema version that makes a task's project and number unique */
export const TASK_KEY_INDEX_VERSION = 7;

export const taskKeyIndexMigration: Migration = {
  version: TASK_KEY_INDEX_VERSION,
  name: "unique task key",
  rebuilds: [],
  apply(db) {
    // SQLite's own error for a failed unique index names only the columns, so find the duplicated keys first.
    const duplicates = db
      .query<{ key: string }>(`SELECT project.key || '-' || task.number AS key
      FROM task
      JOIN project ON project.id = task.project_id
      GROUP BY task.project_id, task.number
      HAVING COUNT(*) > 1
      ORDER BY project.key, task.number`)
      .all();

    if (duplicates.length > 0) {
      const keys = duplicates.map(({ key }) => key).join(", ");
      throw new CoreError(
        `Each of these task keys belongs to more than one task: ${keys}`,
        "conflict",
        {
          entity: "task",
          reason: "already_exists",
        },
      );
    }

    db.exec("CREATE UNIQUE INDEX task_project_number ON task (project_id, number)");
  },
};
