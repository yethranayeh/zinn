import type { Migration } from "./registry.js";

export const taskDeadlineMigration: Migration = {
  version: 3,
  name: "task deadline",
  rebuilds: [],
  apply(db) {
    db.exec("ALTER TABLE task ADD COLUMN due_at INTEGER");
  },
};
