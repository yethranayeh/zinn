import type { Migration } from "./registry.js";

export const actorIdentityMigration: Migration = {
  version: 2,
  name: "store declared actor identity",
  rebuilds: ["activity"],
  apply(db) {
    // Older Bun instances can swallow execution errors when a semicolon is followed by whitespace
    db.exec(`
      CREATE TABLE new_activity (
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
      )
    `);
    db.exec(`
      INSERT INTO new_activity (
        id, created_at, actor_name, actor_email, actor_kind,
        entity_type, entity_id, action, changes
      ) SELECT
        id, created_at, actor_name, actor_email, actor_kind,
        entity_type, entity_id, action, changes
      FROM activity
    `);
    db.exec("DROP TABLE activity;");
    db.exec("ALTER TABLE new_activity RENAME TO activity;");
  },
};
