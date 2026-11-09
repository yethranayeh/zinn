import type { ColumnCategory } from "../schemas/column.js";
import type { Migration } from "./registry.js";

/** Categories for the default column names, keyed by lowercase name. */
const CATEGORY_BY_DEFAULT_NAME: ReadonlyMap<string, ColumnCategory> = new Map([
  ["backlog", "backlog"],
  ["todo", "todo"],
  ["in progress", "in_progress"],
  ["doing", "in_progress"],
  ["review", "review"],
  ["done", "done"],
  ["cancelled", "cancelled"],
]);

export const columnCategoryMigration: Migration = {
  version: 5,
  name: "column category",
  rebuilds: [],
  apply(db) {
    // Existing columns start as todo. Core always writes a category, so new columns never rely on this default.
    db.exec("ALTER TABLE project_column ADD COLUMN category TEXT NOT NULL DEFAULT 'todo'");

    const columns = db
      .query<{ id: string; name: string }>("SELECT id, name FROM project_column")
      .all();
    const setCategory = db.query("UPDATE project_column SET category = ? WHERE id = ?");

    for (const { id, name } of columns) {
      const category = CATEGORY_BY_DEFAULT_NAME.get(name.toLowerCase());
      if (category !== undefined) {
        setCategory.run(category, id);
      }
    }
  },
};
