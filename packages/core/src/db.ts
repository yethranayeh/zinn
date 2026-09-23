import { Database } from "bun:sqlite";
import { DB_PATH, DB_TABLE } from "./constant";
import { ensureConfigSetup } from "./config";

let db: Database | null = null;

function initDb() {
  // TODO: turn on strict mode, and refactor `$` prefixes: https://bun.com/docs/runtime/sqlite#strict-true-lets-you-bind-values-without-prefixes
  const db = new Database(DB_PATH, { create: true });

  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = true;");
  // TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup

  // --- PROJECT TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.project} (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  task_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER);`).run();

  // --- PROJECT COLUMN TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.projectColumn} (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  column_order  TEXT);`).run();

  // --- TASK TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.task} (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES ${DB_TABLE.project}(id) ON DELETE CASCADE,
  column_id   TEXT NOT NULL REFERENCES ${DB_TABLE.projectColumn}(id),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  task_order  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER);`).run();

  // --- TASK RELATIONS TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.task_relations} (
  id              TEXT PRIMARY KEY,
  source_task_id  TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
  target_task_id  TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL CHECK (
    relation_type IN ('related', 'dependency', 'duplicate')
  ),
  created_at      INTEGER NOT NULL,

  UNIQUE (source_task_id, target_task_id, relation_type),
  CHECK (source_task_id <> target_task_id));`).run();

  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.label} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    color TEXT NOT NULL CHECK (color IN ('red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'))
  );`).run();

  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.taskLabel} (
    task_id TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES ${DB_TABLE.label}(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );`).run();

  // --- ACTIVITY TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.activity} (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  actor_name  TEXT NOT NULL,
  actor_email TEXT,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task')),
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN (
    'create', 'edit', 'move', 'order', 'archive', 'unarchive', 'delete',
    'relation_create', 'relation_delete'
  )),
  changes     TEXT);`).run();

  return db;
}

export function getDb() {
  if (db == null) {
    try {
      ensureConfigSetup();
      db = initDb();
    } catch (err) {
      throw new Error("There was a problem initializing Zinn", { cause: err });
    }
  }

  return db;
}
