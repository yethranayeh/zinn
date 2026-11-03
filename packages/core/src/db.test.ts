import * as adapter from "#sqlite";
import { expect, spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStorage } from "./storage";
import { assertWritable, configureDatabase, getDb, resetDatabaseForTests } from "./db";
import { MissingDatabaseError, ReadOnlyDatabaseError, UnmarkedDatabaseError } from "./migrations/open-policy";
import { createSchema } from "./migrations/runner";
import type { OpenOptions } from "./sqlite/database";
import { openResolvedWith, SqliteError } from "./sqlite/database";
import { withTestStore } from "./testing";

type ControlledFailure = { code: string; errno: number } | { apiError: true };

function runInitializationCheck(inputFailure: ControlledFailure, failures: number, delayMs = 0) {
  return withTestStore(() => {

    const failureSpec = inputFailure;
    function controlledFailure() {
      if ("apiError" in failureSpec) {
        return Object.assign(new TypeError("controlled startup failure"), { code: "SQLITE_BUSY" });
      }
      return Object.assign(new Error("controlled startup failure"), {
        name: "SQLiteError", errno: failureSpec.errno,
      });
    }
    const failure = controlledFailure();
    let remaining = failures;
    let opened = 0;
    let closed = 0;
    const driver = {
      connect(path: string, options: OpenOptions) {
        const connection = adapter.driver.connect(path, options);
        opened++;
        return {
          prepare: (sql: string) => connection.prepare(sql),
          exec(sql: string) {
            if (sql.includes("journal_mode") && remaining > 0) {
              remaining--;
              Bun.sleepSync(delayMs);
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
    const mockedOpen = spyOn(adapter, "openResolvedDatabase").mockImplementation((path, options) => openResolvedWith(driver, path, options));
    const began = performance.now();
    try {

      const db = getDb({ createsDatabase: true });
      const cached = getDb() === db;
      const timeout = db.query<{ timeout: number }>("PRAGMA busy_timeout").get()!.timeout;
      const foreignKeys = db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get()!.foreign_keys;
      const synchronous = db.query<{ synchronous: number }>("PRAGMA synchronous").get()!.synchronous;
      const fullfsync = db.query<{ fullfsync: number }>("PRAGMA fullfsync").get()!.fullfsync;
      db.close();
      return { ok: true, opened, closed, cached, timeout, foreignKeys, synchronous, fullfsync };
    } catch (error) {
      assert.ok(error instanceof Error);
      const cause = error.cause;
      const normalized = cause instanceof SqliteError;
      return {
        ok: false, opened, closed, message: error.message, code: cause instanceof SqliteError ? cause.code : undefined,
        errcode: cause instanceof SqliteError ? cause.errcode : undefined, normalized,
        retainedCause: (cause instanceof SqliteError ? cause.cause : cause) === failure,
        elapsedMs: performance.now() - began,
      };
    } finally { mockedOpen.mockRestore(); }
  });
}

const SQLITE_BUSY = { code: "SQLITE_BUSY", errno: 5 };

test.each([
  SQLITE_BUSY,
  { code: "SQLITE_BUSY_RECOVERY", errno: 261 },
  { code: "SQLITE_IOERR_TRUNCATE", errno: 1546 },
])("initialization recovers from $code and closes failed connections", (failure) => {
  expect(runInitializationCheck(failure, 1)).toEqual({
    ok: true, opened: 2, closed: 2, cached: true, timeout: 30_000, foreignKeys: 1, synchronous: 2, fullfsync: 1,
  });
});

test("persistent startup contention stops retrying and retains the cause", () => {
  const result = runInitializationCheck(SQLITE_BUSY, 10);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(5);
  expect(result.closed).toBe(result.opened);
  expect(result.normalized).toBe(true);
  expect(result.retainedCause).toBe(true);
  expect(result.code).toBe(SQLITE_BUSY.code);
  expect(result.errcode).toBe(SQLITE_BUSY.errno);
  expect(result.message).toContain("controlled startup failure");
  expect(result.message).toContain(SQLITE_BUSY.code);
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
  { code: "SQLITE_BUSY_TIMEOUT", errno: 773 },
  // An unlisted BUSY subtype keeps the display name but is not an exact startup retry code.
  { code: "SQLITE_BUSY", errno: (100 << 8) | 5 },
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
  expect(result.message).toContain("controlled startup failure");
  expect(result.message).toContain(failure.code);
});

test("initialization does not retry an error that is not a SQLite failure", () => {
  const result = runInitializationCheck({ apiError: true }, 1);

  expect(result.ok).toBe(false);
  expect(result.opened).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.normalized).toBe(false);
  expect(result.retainedCause).toBe(true);
});

test("reset closes connections and prepared statements before selecting another store", () => {
  withTestStore((directory) => {
    const originalStorage = getStorage();
    const original = getDb({ createsDatabase: true });
    original.exec("CREATE TABLE reset_test (value TEXT); INSERT INTO reset_test VALUES ('kept')");
    const statement = original.query<{ value: string }>("SELECT value FROM reset_test");
    expect(statement.get()).toEqual({ value: "kept" });
    const next = join(directory, "next");
    mkdirSync(next);
    process.env.ZINN_DIR = next;
    expect(getStorage()).toEqual(originalStorage);
    expect(getStorage()).not.toBe(originalStorage);
    expect(getDb()).toBe(original);

    resetDatabaseForTests();
    resetDatabaseForTests();
    expect(() => original.exec("SELECT 1")).toThrow();
    expect(() => statement.get()).toThrow();
    expect(getStorage().directory).toBe(next);
    expect(getDb({ createsDatabase: true })).not.toBe(original);
    expect(getDb().query("SELECT name FROM sqlite_schema WHERE name = 'reset_test'").all()).toEqual([]);

    resetDatabaseForTests();
    process.env.ZINN_DIR = directory;
    expect(getDb().query("SELECT value FROM reset_test").get()).toEqual({ value: "kept" });
  });
});

test("reset clears the opening policy and read-only state", () => {
  withTestStore((directory) => {
    const path = getStorage().databasePath;
    mkdirSync(getStorage().dataDirectory);
    const fixture = adapter.openDatabase(path);
    try {
      createSchema(fixture);
      fixture.exec("PRAGMA user_version = 0");
    } finally {
      fixture.close();
    }
    configureDatabase({ client: "test", version: "1", executable: "/test/zinn", release: "source", allowsLegacyRead: true });
    getDb();
    expect(() => assertWritable()).toThrow(ReadOnlyDatabaseError);
    resetDatabaseForTests();
    expect(() => getDb()).toThrow(UnmarkedDatabaseError);

    const fresh = join(directory, "fresh");
    mkdirSync(fresh);
    resetDatabaseForTests();
    process.env.ZINN_DIR = fresh;
    getDb({ createsDatabase: true });
    expect(() => assertWritable()).not.toThrow();
  });
});

test("a failed close leaves the connection and selected store available for cleanup", () => {
  withTestStore(() => {
    const storage = getStorage();
    const connection = getDb({ createsDatabase: true });
    const failure = new Error("controlled close failure");
    const close = spyOn(connection, "close").mockImplementation(() => { throw failure; });
    try {
      expect(() => resetDatabaseForTests()).toThrow(failure);
      expect(getDb()).toBe(connection);
      expect(getStorage()).toEqual(storage);
      expect(() => configureDatabase({ client: "test", version: "1", executable: "/test/zinn", release: "source", allowsLegacyRead: false })).toThrow();
      expect(connection.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      close.mockRestore();
    }
    resetDatabaseForTests();
    expect(() => connection.exec("SELECT 1")).toThrow();
  });
});

test("ZINN-458: an open that does not create leaves a store without a database as it was", () => {
  withTestStore((directory) => {
    expect(() => getDb()).toThrow(MissingDatabaseError);
    expect(() => assertWritable()).toThrow(MissingDatabaseError);
    expect(readdirSync(directory)).toEqual([]);

    mkdirSync(getStorage().dataDirectory);
    writeFileSync(getStorage().databasePath, "");
    expect(() => getDb()).toThrow(MissingDatabaseError);
    expect(readdirSync(getStorage().dataDirectory)).toEqual(["zinn.sqlite"]);
    expect(statSync(getStorage().databasePath).size).toBe(0);
  });
});

test("ZINN-458: an open that creates initializes a zero-byte database file", () => {
  withTestStore(() => {
    mkdirSync(getStorage().dataDirectory);
    writeFileSync(getStorage().databasePath, "");
    getDb({ createsDatabase: true });
    resetDatabaseForTests();
    expect(() => assertWritable()).not.toThrow();
  });
});
