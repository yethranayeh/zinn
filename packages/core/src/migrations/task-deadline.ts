import type { Migration } from "./registry.js";

/** The schema version that adds task deadlines */
export const TASK_DEADLINE_VERSION = 3;

export const taskDeadlineMigration: Migration = {
  version: TASK_DEADLINE_VERSION,
  name: "task deadline",
  rebuilds: [],
  apply(db) {
    db.exec("ALTER TABLE task ADD COLUMN due_at INTEGER");
  },
};
