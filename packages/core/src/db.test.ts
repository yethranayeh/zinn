import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type ControlledFailure = { code: string; errno: number } | { apiError: true };

function runInitializationCheck(failure: ControlledFailure, failures: number, delayMs = 0) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-initialization-"));
  const modulePath = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

  try {
    // Fails startup at the adapter boundary: the real bun:sqlite connection, with its journal_mode
    // PRAGMA throwing an error shaped like bun:sqlite's (name and errno) for the code under test.
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import * as adapter from ${modulePath("./sqlite/bun.ts")};
      import { openWith, SqliteError } from ${modulePath("./sqlite/database.ts")};
      const failureSpec = ${JSON.stringify(failure)};
      function controlledFailure() {
        if (failureSpec.apiError) {
          return Object.assign(new TypeError("controlled startup failure"), { code: "SQLITE_BUSY" });
        }
        return Object.assign(new Error("controlled startup failure"), {
          name: "SQLiteError", errno: failureSpec.errno,
        });
      }
      const failure = controlledFailure();
      let remaining = ${failures};
      let opened = 0;
      let closed = 0;
      const driver = {
        connect(path, options) {
          const connection = adapter.driver.connect(path, options);
          opened++;
          return {
            prepare: (sql) => connection.prepare(sql),
            exec(sql) {
              if (sql.includes("journal_mode") && remaining > 0) {
                remaining--;
                Bun.sleepSync(${delayMs});
                throw failure;
              }
              connection.exec(sql);
            },
            get inTransaction() {
              return connection.inTransaction;
            },
            close() {
              closed++;
              connection.close();
            },
          };
        },
        resultCode: adapter.driver.resultCode,
      };
      mock.module(${modulePath("./sqlite/bun.ts")}, () => ({
        ...adapter,
        openDatabase: (path, options) => openWith(driver, path, options),
      }));
      const began = performance.now();
      try {
        const { getDb } = await import(${modulePath("./db.ts")});
        const db = getDb();
        const cached = getDb() === db;
        const timeout = db.query("PRAGMA busy_timeout").get().timeout;
        const foreignKeys = db.query("PRAGMA foreign_keys").get().foreign_keys;
        const synchronous = db.query("PRAGMA synchronous").get().synchronous;
        db.close();
        console.log(JSON.stringify({ ok: true, opened, closed, cached, timeout, foreignKeys, synchronous }));
      } catch (error) {
        const normalized = error.cause instanceof SqliteError;
        console.log(JSON.stringify({
          ok: false, opened, closed, message: error.message, code: error.cause?.code,
          errcode: error.cause?.errcode, normalized,
          retainedCause: (normalized ? error.cause.cause : error.cause) === failure,
          elapsedMs: performance.now() - began,
        }));
      }
    `], { env: { ...process.env, ZINN_DIR: directory } });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SQLITE_BUSY = { code: "SQLITE_BUSY", errno: 5 };

test.each([
  SQLITE_BUSY,
  { code: "SQLITE_BUSY_RECOVERY", errno: 261 },
  { code: "SQLITE_IOERR_TRUNCATE", errno: 1546 },
])("initialization recovers from $code and closes failed connections", (failure) => {
  expect(runInitializationCheck(failure, 1)).toEqual({
    ok: true, opened: 2, closed: 2, cached: true, timeout: 30_000, foreignKeys: 1, synchronous: 2,
  });
});

test("persistent startup contention stops retrying and retains the cause", () => {
  const result = runInitializationCheck(SQLITE_BUSY, 10);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(5);
  expect(result.closed).toBe(result.opened);
  expect(result.normalized).toBe(true);
  expect(result.retainedCause).toBe(true);
  expect(result.message).toBe("There was a problem initializing Zinn: controlled startup failure (SQLITE_BUSY)");
});

test("initialization does not repeat a wait that already consumed the retry budget", () => {
  const result = runInitializationCheck(SQLITE_BUSY, 2, 1_100);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.retainedCause).toBe(true);
});

test.each([
  { code: "SQLITE_BUSY_SNAPSHOT", errno: 517 },
  { code: "SQLITE_READONLY", errno: 8 },
  { code: "SQLITE_IOERR", errno: 10 },
  { code: "SQLITE_CORRUPT", errno: 11 },
])("initialization reports $code without retrying", (failure) => {
  const result = runInitializationCheck(failure, 1);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.normalized).toBe(true);
  expect(result.retainedCause).toBe(true);
  expect(result.code).toBe(failure.code);
  expect(result.errcode).toBe(failure.errno);
  expect(result.message).toContain(`controlled startup failure (${failure.code})`);
});

test("initialization does not retry an error that is not a SQLite failure", () => {
  const result = runInitializationCheck({ apiError: true }, 1);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.normalized).toBe(false);
  expect(result.retainedCause).toBe(true);
});
