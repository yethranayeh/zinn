import { expect, test } from "bun:test";

import { columnCategoryMigration } from "./column-category";
import { MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { seedBaseline, snapshot, withDatabase } from "./testing";

const previousMigrations = MIGRATIONS.filter(({ version }) => version < columnCategoryMigration.version);
const throughCategory = [...previousMigrations, columnCategoryMigration];

test("category migration assigns categories by default column names and todo to any other name", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    db.exec(`
      INSERT INTO project (id, key, name, task_count, created_at, updated_at)
        VALUES ('p2', 'WEB', 'Web', 0, 1, 1);
      INSERT INTO project_column (id, project_id, name, column_order) VALUES
        ('w1', 'p2', 'backlog', 'a0'), ('w2', 'p2', 'TODO', 'a1'), ('w3', 'p2', 'In Progress', 'a2'),
        ('w4', 'p2', 'DOING', 'a3'), ('w5', 'p2', 'Review', 'a4'), ('w6', 'p2', 'done', 'a5'),
        ('w7', 'p2', 'Cancelled', 'a6'), ('w8', 'p2', 'Blocked', 'a7'), ('w9', 'p2', 'In  Progress', 'a8'),
        ('w10', 'p2', 'Canceled', 'a9')
    `);
    const before = snapshot(db);
    upgradeSchema(db, throughCategory);
    const after = snapshot(db);

    expect(readSchemaVersion(db)).toBe(columnCategoryMigration.version);
    expect(db.query("PRAGMA table_info(project_column)").all().at(-1)).toMatchObject({
      name: "category", type: "TEXT", notnull: 1,
    });
    expect(db.query("SELECT name, category FROM project_column ORDER BY project_id, column_order").all()).toEqual([
      // The baseline seed's columns.
      { name: "Todo", category: "todo" },
      { name: "Done", category: "done" },
      { name: "backlog", category: "backlog" },
      { name: "TODO", category: "todo" },
      { name: "In Progress", category: "in_progress" },
      { name: "DOING", category: "in_progress" },
      { name: "Review", category: "review" },
      { name: "done", category: "done" },
      { name: "Cancelled", category: "cancelled" },
      { name: "Blocked", category: "todo" },
      { name: "In  Progress", category: "todo" },
      { name: "Canceled", category: "todo" },
    ]);
    const preservedRows = Object.fromEntries(Object.entries(after.rows).map(([table, rows]) => [
      table,
      table === "project_column" ? rows.map((row) => {
        const { category, ...previous } = row as Record<string, unknown>;
        return previous;
      }) : rows,
    ]));
    expect(preservedRows).toEqual(before.rows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    withDatabase((fresh) => {
      createSchema(fresh, throughCategory);
      expect(after.schema).toEqual(snapshot(fresh).schema);
    });
  });
});

test("a failed category migration rolls back its column, version and rows", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    const failingMigration = {
      ...columnCategoryMigration,
      apply(connection: Parameters<typeof columnCategoryMigration.apply>[0]) {
        columnCategoryMigration.apply(connection);
        throw new Error("planned category failure");
      },
    };
    expect(() => upgradeSchema(db, [...previousMigrations, failingMigration])).toThrow("planned category failure");
    expect(snapshot(db)).toEqual(before);
  });
});
