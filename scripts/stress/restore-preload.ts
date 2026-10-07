/** Test-only observation and pauses around the real restore and ordinary write transactions. */
import type { Database } from "../../packages/core/src/sqlite/database.ts";
import type { LockOptions } from "../../packages/core/src/migrations/upgrade.ts";

import { mock } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";

const CACHE_PAGES = 100;
const SPILL_PAGES = 10;
const RELEASE_POLL_MS = 5;

function event(stage: string) {
  const file = process.env.STRESS_EVENTS_FILE;
  if (file != null) {
    appendFileSync(file, `${Date.now()} ${process.pid} ${stage}\n`);
  }
  if (process.env.STRESS_RESTORE_PAUSE_AT === stage) {
    const release = process.env.STRESS_RESTORE_RELEASE_FILE;
    const pauseMs = Number(process.env.STRESS_RESTORE_PAUSE_MS ?? 0);
    const began = performance.now();
    while (performance.now() - began < pauseMs) {
      if (release != null && existsSync(release)) {
        return;
      }
      Bun.sleepSync(RELEASE_POLL_MS);
    }
  }
}

function corePath(path: string) {
  return new URL(`../../packages/core/src/${path}`, import.meta.url).pathname;
}

if (process.env.STRESS_RESTORE_WRITER === "1") {
  const path = corePath("db.ts");
  const original = { ...(await import(path)) } as typeof import("../../packages/core/src/db.ts");
  mock.module(path, () => ({
    ...original,
    writeTransaction: <T>(work: () => T) => {
      original.getDb();
      event("writer-ready");
      return original.writeTransaction(work);
    },
  }));
} else {
  const backupPath = corePath("db/backup.ts");
  const backup = {
    ...(await import(backupPath)),
  } as typeof import("../../packages/core/src/db/backup.ts");
  mock.module(backupPath, () => ({
    ...backup,
    create: (...args: Parameters<typeof backup.create>) => {
      event("backup-start");
      const result = backup.create(...args);
      event("backed-up");
      return result;
    },
  }));

  const runnerPath = corePath("migrations/runner.ts");
  const runner = {
    ...(await import(runnerPath)),
  } as typeof import("../../packages/core/src/migrations/runner.ts");
  mock.module(runnerPath, () => ({
    ...runner,
    assertForeignKeys: (...args: Parameters<typeof runner.assertForeignKeys>) => {
      const result = runner.assertForeignKeys(...args);
      if (args[1] === "restore") {
        event("copied");
      }
      return result;
    },
  }));

  const upgradePath = corePath("migrations/upgrade.ts");
  const upgrade = {
    ...(await import(upgradePath)),
  } as typeof import("../../packages/core/src/migrations/upgrade.ts");
  mock.module(upgradePath, () => ({
    ...upgrade,
    withMigrationLock: <T>(
      db: Database,
      path: string,
      options: LockOptions & { operation?: string },
      work: () => T,
    ): T => {
      if (options.operation !== "restore") {
        return upgrade.withMigrationLock(db, path, options, work);
      }
      // Shrink the restore connection's cache so the real row copy spills before COMMIT.
      db.exec(`PRAGMA cache_size = ${CACHE_PAGES}; PRAGMA cache_spill = ${SPILL_PAGES}`);
      event("start");
      const result = upgrade.withMigrationLock(db, path, options, () => {
        event("locked");
        const copied = work();
        event("before-commit");
        return copied;
      });
      event("after-commit");
      return result;
    },
  }));
}
