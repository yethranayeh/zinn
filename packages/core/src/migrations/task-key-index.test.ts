import { expect, test } from "bun:test";

import { CoreError } from "../errors";
import { taskKeyIndexMigration } from "./task-key-index";
import { MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { seedBaseline, snapshot, withDatabase } from "./testing";

const INDEX_NAME = "task_project_number";

const previousMigrations = MIGRATIONS.filter(({ version }) => version < taskKeyIndexMigration.version);
const throughKeyIndex = [...previousMigrations, taskKeyIndexMigration];

test("ZINN-598: key index migration keeps every row and matches a fresh schema", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    upgradeSchema(db, throughKeyIndex);
    const after = snapshot(db);

    expect(readSchemaVersion(db)).toBe(taskKeyIndexMigration.version);
    expect(after.rows).toEqual(before.rows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    withDatabase((fresh) => {
      createSchema(fresh, throughKeyIndex);
      expect(after.schema).toEqual(snapshot(fresh).schema);
    });
  });
});

test("ZINN-598: a database with a duplicated task key stays unchanged and the error names the key", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    db.exec(`INSERT INTO task (id, project_id, column_id, number, title, comment_count, created_at, updated_at)
      VALUES ('t4', 'p1', 'c1', 2, 'Duplicate', 0, 11, 11)`);
    const before = snapshot(db);

    let thrown: unknown;
    try {
      upgradeSchema(db, throughKeyIndex);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoreError);
    const coreError = thrown as CoreError;
    expect(coreError.kind).toBe("conflict");
    expect(coreError.facts).toEqual({ entity: "task", reason: "already_exists" });
    expect(coreError.message).toContain("APP-2");
    expect(snapshot(db)).toEqual(before);
  });
});

test("ZINN-598: after the upgrade a second task with an existing key is refused", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, throughKeyIndex);

    expect(() =>
      db.exec(`INSERT INTO task (id, project_id, column_id, number, title, comment_count, created_at, updated_at)
        VALUES ('t4', 'p1', 'c1', 2, 'Duplicate', 0, 11, 11)`),
    ).toThrow();
  });
});

test("ZINN-598: looking up a task by project and number uses the key index", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, throughKeyIndex);

    const plan = db
      .query<{ detail: string }, [string, number]>(
        "EXPLAIN QUERY PLAN SELECT * FROM task WHERE project_id = ? AND number = ?",
      )
      .all("p1", 2)
      .map(({ detail }) => detail);

    expect(plan.some((detail) => detail.includes(INDEX_NAME))).toBe(true);
    expect(plan.some((detail) => detail.startsWith("SCAN"))).toBe(false);
  });
});
