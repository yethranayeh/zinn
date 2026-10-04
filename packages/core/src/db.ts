import type { Database } from "./sqlite/database";

import { openDatabase } from "#sqlite";

import { DB_PATH, DB_TABLE } from "./constant";
import { ensureConfigSetup } from "./config";
import { attachSuppressed, SqliteError } from "./sqlite/database";

let db: Database | null = null;

const BUSY_TIMEOUT_MS = 30_000;
const INITIALIZATION_RETRY_BUDGET_MS = 1_000;
const INITIALIZATION_ATTEMPTS = 5;

function initDb() {
  const db = openDatabase(DB_PATH);

  try {
    // Arm waiting before WAL setup and schema creation can encounter another process.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = true;");
    // TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup

    // --- PROJECT TABLE
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.project} (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
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
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES ${DB_TABLE.project}(id) ON DELETE CASCADE,
    column_id      TEXT NOT NULL REFERENCES ${DB_TABLE.projectColumn}(id),
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    priority       TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    task_order     TEXT,
    comment_count  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    archived_at    INTEGER);`).run();

    // --- TASK RELATIONS TABLE
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.task_relations} (
    id              TEXT PRIMARY KEY,
    source_task_id  TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
    target_task_id  TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL CHECK (
      relation_type IN ('related', 'dependency', 'duplicate', 'subtask')
    ),
    created_at      INTEGER NOT NULL,

    UNIQUE (source_task_id, target_task_id, relation_type),
    CHECK (source_task_id <> target_task_id));`).run();

    // --- TASK LABELS
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.label} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT NOT NULL CHECK (color IN ('red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'))
    );`).run();

    // --- TASK LABEL RECORDS
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.taskLabel} (
      task_id TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES ${DB_TABLE.label}(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );`).run();

    // --- TASK COMMENT
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.comment} (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES ${DB_TABLE.task}(id) ON DELETE CASCADE,
      number       INTEGER NOT NULL,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (task_id, number)
    );`).run();

    // --- TASK SEARCH INDEX
    db.query(`CREATE VIRTUAL TABLE IF NOT EXISTS ${DB_TABLE.taskSearch} USING fts5(
      task_id UNINDEXED,
      title,
      description,
      comments,
      tokenize = 'unicode61 remove_diacritics 2'
    );`).run();

    // --- ACTIVITY TABLE
    db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.activity} (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    actor_name  TEXT NOT NULL,
    actor_email TEXT,
    actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'project', 'column', 'label')),
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN (
      'create', 'edit', 'move', 'order', 'archive', 'unarchive', 'delete',
      'relation_create', 'relation_delete',
      'comment_create', 'comment_edit', 'comment_delete'
    )),
    changes     TEXT);`).run();

    return db;
  } catch (err) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(err, closeError);
    }

    throw err;
  }
}

export function getDb() {
  if (db == null) {
    try {
      ensureConfigSetup();
      const began = performance.now();

      for (let attempt = 1; ; attempt++) {
        try {
          db = initDb();
          break;
        } catch (err) {
          // Binding and API errors are not SqliteErrors, so they are never retried.
          const code = err instanceof SqliteError ? err.code : null;
          const isTransientStartupError =
            code === "SQLITE_BUSY" ||
            code === "SQLITE_BUSY_RECOVERY" ||
            code === "SQLITE_IOERR_TRUNCATE";
          const retryBudgetExhausted =
            attempt >= INITIALIZATION_ATTEMPTS ||
            performance.now() - began >= INITIALIZATION_RETRY_BUDGET_MS;

          if (!isTransientStartupError || retryBudgetExhausted) {
            throw err;
          }

          // Some startup races bypass SQLite's busy handler. Do not repeat a long wait.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
        }
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const causeDetails = error.code == null ? error.message : `${error.message} (${error.code})`;
      throw new Error(`There was a problem initializing Zinn: ${causeDetails}`, { cause: err });
    }
  }

  return db;
}
