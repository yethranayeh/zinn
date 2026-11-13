import type { Database } from "../sqlite/database.js";

import { TASK_SEARCH_DEFINITION } from "./baseline.js";

/** The schema version `LATEST_STATEMENTS` create, which is the newest one in **registry.ts** */
export const LATEST_SCHEMA_VERSION = 5;

/**
 * The whole schema at `LATEST_SCHEMA_VERSION`, which `createLatestSchema` runs on every fresh database.
 * Each statement is the text SQLite stores after the baseline and every migration,
 *  so a fresh database has the same definitions as an upgraded one.
 * A column added by ALTER TABLE therefore follows a comma at the end of its table, and a rebuilt table has a quoted name.
 * A new migration changes these statements and the version with it.
 */
export const LATEST_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE project (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    task_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    archived_at INTEGER)`,

  `CREATE TABLE project_column (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    column_order  TEXT, category TEXT NOT NULL DEFAULT 'todo')`,

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
    archived_at    INTEGER, due_at INTEGER)`,

  `CREATE TABLE task_relations (
    id              TEXT PRIMARY KEY,
    source_task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    target_task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,

    UNIQUE (source_task_id, target_task_id, relation_type),
    CHECK (source_task_id <> target_task_id))`,

  `CREATE TABLE label (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT NOT NULL
    )`,

  `CREATE TABLE task_label (
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    )`,

  `CREATE TABLE comment (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      number       INTEGER NOT NULL,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (task_id, number)
    )`,

  TASK_SEARCH_DEFINITION,

  `CREATE TABLE "activity" (
        id               TEXT PRIMARY KEY,
        created_at       INTEGER NOT NULL,
        actor_name       TEXT,
        actor_email      TEXT,
        actor_kind       TEXT NOT NULL,
        actor_source     TEXT,
        actor_session_id TEXT,
        actor_thread_id  TEXT,
        actor_agent      TEXT,
        actor_model      TEXT,
        actor_effort     TEXT,
        entity_type      TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        action           TEXT NOT NULL,
        changes          TEXT
      , actor_client TEXT)`,
];

/** Creates the latest schema. The runner calls it inside its transaction, on an empty database. */
export function createLatest(db: Database) {
  for (const statement of LATEST_STATEMENTS) {
    db.exec(statement);
  }
}
