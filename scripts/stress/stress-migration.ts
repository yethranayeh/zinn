/**
 * The test-only schema version 2 that the migration scenarios put after core's empty migration chain,
 *  and what it does while it runs. migration-preload.ts registers it in the child processes.
 *
 * Settings come from the environment, so one definition serves every scenario:
 *   STRESS_EVENTS_FILE            append "<ms> <pid> <event>" lines for each stage in MIGRATION_EVENTS
 *   STRESS_MIGRATION_PAUSE_AT     one of those events; the migration sleeps there for STRESS_MIGRATION_PAUSE_MS
 *   STRESS_MIGRATION_PAUSE_MS     how long that pause lasts (also the hold that makes others wait for the lock)
 *   STRESS_MIGRATION_SPILL_BYTES  shrinks the page cache for the migration and writes and drops a scratch
 *                                 table this big, so uncommitted pages reach the -wal file
 */
import type { Database } from "../../packages/core/src/sqlite/database.ts";
import type { Migration } from "../../packages/core/src/migrations/registry.ts";

import { appendFileSync } from "node:fs";

import { regenerateSearch } from "../../packages/core/src/migrations/search.ts";
import { rebuildTask } from "../../packages/core/src/migrations/testing.ts";

export const MIGRATION_EVENTS = ["start", "rebuilt", "spilled", "before-commit"] as const;
export type MigrationEvent = (typeof MIGRATION_EVENTS)[number];

const SPILL_ROW_BYTES = 1_000_000;
// Bun's SQLite keeps up to 2000 pages in memory and spills only past 20000 dirty ones (about 80 MB), so a small
//  fixture never reaches the -wal file before its commit. A tiny cache makes it spill from the first few pages.
const SPILLING_CACHE_PAGES = 100;
const SPILLING_SPILL_PAGES = 10;

function recordEvent(event: MigrationEvent) {
  const eventsFile = process.env.STRESS_EVENTS_FILE;
  if (eventsFile != null) {
    appendFileSync(eventsFile, `${Date.now()} ${process.pid} ${event}\n`);
  }

  if (process.env.STRESS_MIGRATION_PAUSE_AT === event) {
    Bun.sleepSync(Number(process.env.STRESS_MIGRATION_PAUSE_MS ?? 0));
  }
}

/** Makes the connection write dirty pages to the -wal file long before the transaction commits. */
function forceSpilling(db: Database) {
  db.exec(`PRAGMA cache_size = ${SPILLING_CACHE_PAGES}`);
  db.exec(`PRAGMA cache_spill = ${SPILLING_SPILL_PAGES}`);
}

/** Fills and drops a scratch table, which leaves the schema as it was. */
function spillCache(db: Database, bytes: number) {
  db.exec("CREATE TABLE stress_spill (payload BLOB)");
  for (let written = 0; written < bytes; written += SPILL_ROW_BYTES) {
    db.exec(`INSERT INTO stress_spill VALUES (randomblob(${SPILL_ROW_BYTES}))`);
  }
  db.exec("DROP TABLE stress_spill");
}

/** Rebuilds the task table, which has child tables, and regenerates search, like the largest real upgrades. */
export const STRESS_MIGRATION: Migration = {
  version: 2,
  name: "stress rebuild",
  rebuilds: ["task"],
  regeneratesSearch: true,
  apply(db) {
    const spillBytes = Number(process.env.STRESS_MIGRATION_SPILL_BYTES ?? 0);
    if (spillBytes > 0) {
      forceSpilling(db);
    }

    recordEvent("start");
    rebuildTask(db);
    regenerateSearch(db);
    recordEvent("rebuilt");

    if (spillBytes > 0) {
      spillCache(db, spillBytes);
    }
    recordEvent("spilled");
    recordEvent("before-commit");
  },
};
