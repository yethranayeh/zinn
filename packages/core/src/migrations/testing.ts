import type { Database } from "../sqlite/database";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { createSchema, readSchemaVersion } from "./runner";

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

/** Shared fixtures for migration tests. */
export function withDirectory(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-migrations-"));

  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A database file set up the way getDb() sets up its connection. */
export function withDatabase(
  check: (db: Database) => void,
  open = (path: string) => openDatabase(path),
) {
  withDirectory((directory) => {
    const db = open(join(directory, "zinn.sqlite"));

    try {
      db.exec("PRAGMA busy_timeout = 30000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      check(db);
    } finally {
      db.close();
    }
  });
}

/** A database at the baseline version holding a project with tasks, and the tasks' child rows. */
export function seedBaseline(db: Database) {
  createSchema(db, []);
  db.exec(`
    INSERT INTO project (id, key, name, task_count, created_at, updated_at)
      VALUES ('p1', 'APP', 'App', 3, 1, 1);
    INSERT INTO project_column (id, project_id, name, column_order)
      VALUES ('c1', 'p1', 'Todo', 'a0'), ('c2', 'p1', 'Done', 'a1');
    INSERT INTO task (id, project_id, column_id, number, title, priority, comment_count, created_at, updated_at)
      VALUES ('t1', 'p1', 'c1', 1, 'First', 'high', 2, 2, 2),
             ('t2', 'p1', 'c1', 2, 'Second', NULL, 1, 3, 3),
             ('t3', 'p1', 'c2', 3, 'Third', 'low', 0, 4, 4);
    INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
      VALUES ('r1', 't1', 't2', 'subtask', 5), ('r2', 't2', 't3', 'dependency', 6);
    INSERT INTO label (id, name, color) VALUES ('l1', 'bug', 'red'), ('l2', 'unused', 'blue');
    INSERT INTO task_label (task_id, label_id) VALUES ('t1', 'l1'), ('t3', 'l1');
    INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('m1', 't1', 1, 'one', 7, 7), ('m2', 't1', 2, 'two', 8, 8), ('m3', 't2', 1, 'three', 9, 9);
    INSERT INTO task_search (task_id, title, description, comments)
      VALUES ('t1', 'First', NULL, 'one two'), ('t2', 'Second', NULL, 'three');
    INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action)
      VALUES ('a1', 10, 'Test Human', 'human', 'task', 't1', 'create');
  `);
}

export function schemaObjects(db: Database) {
  return db
    .query<SchemaObject>("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
    .all();
}

export function count(db: Database, table: string) {
  return db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

export function foreignKeys(db: Database) {
  return db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get()!.foreign_keys;
}

/** The schema, version and every row, to compare a database before and after a failed upgrade. */
export function snapshot(db: Database) {
  const schema = schemaObjects(db);
  const tables = schema.filter(({ type, name }) => type === "table" && !name.startsWith("sqlite_"));
  const rows = Object.fromEntries(
    tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name}`).all()]),
  );

  return { version: readSchemaVersion(db), schema, rows };
}

/** The baseline task table, rebuilt the way SQLite documents. */
export function rebuildTask(db: Database) {
  db.exec(`
    CREATE TABLE new_task (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      column_id      TEXT NOT NULL REFERENCES project_column(id),
      number         INTEGER NOT NULL,
      title          TEXT NOT NULL,
      description    TEXT,
      priority       TEXT,
      task_order     TEXT,
      comment_count  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      archived_at    INTEGER);
    INSERT INTO new_task SELECT * FROM task;
    DROP TABLE task;
    ALTER TABLE new_task RENAME TO task;
  `);
}
