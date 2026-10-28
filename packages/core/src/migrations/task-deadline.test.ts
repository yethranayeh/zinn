import { expect, test } from "bun:test";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { actorIdentityMigration } from "./actor-identity";
import { taskDeadlineMigration } from "./task-deadline";
import { seedBaseline, snapshot, withDatabase } from "./testing";

test("deadline migration preserves version 2 rows and foreign keys while adding a nullable field", () => {
  withDatabase(db => {
    seedBaseline(db);
    upgradeSchema(db, [actorIdentityMigration]);
    const before = snapshot(db);
    const columns = db.query<{ name: string }>("PRAGMA table_info(task)").all().map(row => row.name);
    const existingForeignKeys = Object.fromEntries(Object.keys(before.rows).map(table =>
      [table, db.query("SELECT * FROM pragma_foreign_key_list(?)").all(table)]));
    upgradeSchema(db);
    expect(readSchemaVersion(db)).toBe(taskDeadlineMigration.version);
    const after = snapshot(db);
    expect(Object.fromEntries(Object.entries(after.rows).map(([table, rows]) => [table,
      table === "task" ? rows.map(row => Object.fromEntries(columns.map(column => [column, (row as Record<string, unknown>)[column]]))) : rows,
    ]))).toEqual(before.rows);
    expect(db.query("SELECT due_at FROM task").all()).toEqual([{ due_at: null }, { due_at: null }, { due_at: null }]);
    expect(db.query("PRAGMA table_info(task)").all().at(-1)).toMatchObject({ name: "due_at", type: "INTEGER", notnull: 0 });
    for (const [table, definitions] of Object.entries(existingForeignKeys)) {
      expect(db.query("SELECT * FROM pragma_foreign_key_list(?)").all(table)).toEqual(definitions);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    let freshSchema: typeof after.schema = [];
    withDatabase(fresh => {
      createSchema(fresh);
      freshSchema = snapshot(fresh).schema;
    });
    expect(after.schema).toEqual(freshSchema);
  });
});
