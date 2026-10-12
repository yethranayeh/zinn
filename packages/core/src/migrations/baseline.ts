import type { Database } from "../sqlite/database.js";

/**
 * The schema version of the baseline, which is the schema every Zinn database had when schema versions began.
 * PRAGMA user_version 0 is SQLite's default, so it basically means an unmarked Zinn DB.
 * @link https://www.sqlite.org/pragma.html#pragma_user_version
 */
export const BASELINE_VERSION = 1;

/** Shared with `regenerateSearch`. */
export const TASK_SEARCH_DEFINITION = `CREATE VIRTUAL TABLE task_search USING fts5(
      task_id UNINDEXED,
      title,
      description,
      comments,
      tokenize = 'unicode61 remove_diacritics 2'
    );`;

/**
 * The baseline `CREATE` statements, which `createSchema` runs on every fresh database.
 * Databases already at the baseline do not run them again,
 *  so every later schema change is a migration in **registry.ts**
 */
const BASELINE_STATEMENTS = [
  `CREATE TABLE project (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    task_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    archived_at INTEGER);`,

  `CREATE TABLE project_column (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    column_order  TEXT);`,

  `CREATE TABLE task (
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
    archived_at    INTEGER);`,

  `CREATE TABLE task_relations (
    id              TEXT PRIMARY KEY,
    source_task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    target_task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,

    UNIQUE (source_task_id, target_task_id, relation_type),
    CHECK (source_task_id <> target_task_id));`,

  `CREATE TABLE label (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT NOT NULL
    );`,

  `CREATE TABLE task_label (
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );`,

  `CREATE TABLE comment (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      number       INTEGER NOT NULL,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (task_id, number)
    );`,

  TASK_SEARCH_DEFINITION,

  `CREATE TABLE activity (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    actor_name  TEXT NOT NULL,
    actor_email TEXT,
    actor_kind  TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    changes     TEXT);`,
];

/** Creates the baseline schema. The runner calls it inside its transaction, on an empty database. */
export function createBaseline(db: Database) {
  for (const statement of BASELINE_STATEMENTS) {
    db.exec(statement);
  }
}
