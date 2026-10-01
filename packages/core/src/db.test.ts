import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function runInitializationCheck(code: string, failures: number, delayMs = 0) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-initialization-"));
  const dbModule = fileURLToPath(new URL("./db.ts", import.meta.url));

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import * as sqlite from "bun:sqlite";
      const OriginalDatabase = sqlite.Database;
      const failure = Object.assign(new Error("controlled startup failure"), { code: ${JSON.stringify(code)} });
      let remaining = ${failures};
      let opened = 0;
      let closed = 0;
      mock.module("bun:sqlite", () => ({
        ...sqlite,
        Database: class extends OriginalDatabase {
          constructor(...args) {
            super(...args);
            opened++;
          }
          run(sql, ...args) {
            if (sql.includes("journal_mode") && remaining > 0) {
              remaining--;
              Bun.sleepSync(${delayMs});
              throw failure;
            }
            return super.run(sql, ...args);
          }
          close(...args) {
            closed++;
            return super.close(...args);
          }
        },
      }));
      const began = performance.now();
      try {
        const { getDb } = await import(${JSON.stringify(dbModule)});
        const db = getDb();
        const cached = getDb() === db;
        const timeout = db.query("PRAGMA busy_timeout").get().timeout;
        const foreignKeys = db.query("PRAGMA foreign_keys").get().foreign_keys;
        db.close();
        console.log(JSON.stringify({ ok: true, opened, closed, cached, timeout, foreignKeys }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false, opened, closed, message: error.message, code: error.cause?.code,
          retainedCause: error.cause === failure, elapsedMs: performance.now() - began,
        }));
      }
    `], { env: { ...process.env, ZINN_DIR: directory } });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each(["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_IOERR_TRUNCATE"])(
  "initialization recovers from %s and closes failed connections",
  (code) => {
    expect(runInitializationCheck(code, 1)).toEqual({
      ok: true, opened: 2, closed: 2, cached: true, timeout: 30_000, foreignKeys: 1,
    });
  },
);

test("persistent startup contention stops retrying and retains the cause", () => {
  const result = runInitializationCheck("SQLITE_BUSY", 10);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(5);
  expect(result.closed).toBe(result.opened);
  expect(result.retainedCause).toBe(true);
  expect(result.message).toBe("There was a problem initializing Zinn: controlled startup failure (SQLITE_BUSY)");
});

test("initialization does not repeat a wait that already consumed the retry budget", () => {
  const result = runInitializationCheck("SQLITE_BUSY", 2, 1_100);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.retainedCause).toBe(true);
});

test.each(["SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT"])(
  "initialization reports %s without retrying",
  (code) => {
    const result = runInitializationCheck(code, 1);

    expect(result.ok).toBe(false);
    expect(result.opened).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.retainedCause).toBe(true);
    expect(result.code).toBe(code);
    expect(result.message).toContain(`controlled startup failure (${code})`);
  },
);
