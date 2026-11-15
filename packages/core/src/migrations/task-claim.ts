import type { Migration } from "./registry.js";

export const taskClaimMigration: Migration = {
  version: 6,
  name: "task claim",
  rebuilds: [],
  apply(db) {
    db.exec(`CREATE TABLE task_claim (
    task_id          TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
    actor_kind       TEXT NOT NULL,
    actor_name       TEXT,
    actor_session_id TEXT,
    actor_thread_id  TEXT,
    claimed_at       INTEGER NOT NULL,
    renewed_at       INTEGER NOT NULL,
    worked_at        INTEGER NOT NULL,
    lease_ms         INTEGER NOT NULL)`);
  },
};
