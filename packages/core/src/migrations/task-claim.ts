import type { Migration } from "./registry.js";

/** The schema version that adds the claim table */
export const TASK_CLAIM_VERSION = 6;

export const taskClaimMigration: Migration = {
  version: TASK_CLAIM_VERSION,
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
