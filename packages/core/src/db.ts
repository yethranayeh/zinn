import { Database } from "bun:sqlite";
import { DB_PATH, DB_TABLE } from "./constant";

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

  // --- TASK TABLE
  db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.task} (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  task_order  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER);`).run();

  return db;
}

db = initDb();

export function getDb() {
  if (db == null) {
    console.error("There was a problem initializing the database");
    process.exit(1);
  }

  return db;
}
