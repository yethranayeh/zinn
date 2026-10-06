import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";
import type { FreeSpace, SpaceMeasurements } from "./space";

import { expect, test } from "bun:test";
import { statSync } from "node:fs";

import { SEARCH_COMMENT_SEPARATOR } from "../search-entry";
import { assertFreeSpace, estimateRequiredFree, measureSpace, readFreeSpace } from "./space";
import { seedBaseline, withDatabase, withDirectory } from "./testing";

function migration(version: number, rebuilds: Array<string>, regeneratesSearch = false): Migration {
  return { version, name: `test ${version}`, rebuilds, regeneratesSearch, apply() {} };
}

const MEASUREMENTS: SpaceMeasurements = {
  pageSize: 4096,
  databaseBytes: 409600,
  rebuildsTables: true,
  rebuiltTableBytes: 40960,
  regeneratesSearch: true,
  searchIndexBytes: 20480,
  searchSourceBytes: 10000,
  taskCount: 10,
  allocatedMainBytes: 409600,
  walBytes: 0,
  shmBytes: 0,
};

// New copies: tables 40960 + 16 pages = 106496, search 4 x (10000 + 128 x 10) rounded to pages + 16 pages = 114688.
// Together 221184, which logs 108 pages in the -wal file (32 + 108 x 4120 bytes).
// Fixed room: 64 KiB plus one 32 KiB step of the -shm file.
test("the estimate adds up on worked numbers", () => {
  expect(estimateRequiredFree(MEASUREMENTS, { includeBackup: true })).toEqual({
    database: 2 * (221184 + 444992 + 98304),
    backup: 2 * 409600,
    temporary: 2 * 221184,
  });
});

test("after the backup, only the remaining work counts", () => {
  expect(estimateRequiredFree(MEASUREMENTS, { includeBackup: false }).backup).toBe(0);
});

test("the old search index sets the search allowance when it is larger than the source payload", () => {
  const measurements = { ...MEASUREMENTS, rebuildsTables: false, searchIndexBytes: 409600 };
  // The new search copy is as large as the old index, plus 16 pages.
  expect(estimateRequiredFree(measurements, { includeBackup: false }).temporary).toBe(2 * 475136);
});

test("unallocated main-file space adds to the database allowance", () => {
  const base = estimateRequiredFree(MEASUREMENTS, { includeBackup: false }).database;
  const unallocated = estimateRequiredFree(
    { ...MEASUREMENTS, allocatedMainBytes: 0 },
    { includeBackup: false },
  ).database;
  expect(unallocated - base).toBe(2 * 409600);
});

test("the -shm allowance covers only growth beyond the current -shm file", () => {
  const allocated = { ...MEASUREMENTS, shmBytes: 32768 };
  const none = estimateRequiredFree(allocated, { includeBackup: false }).database;

  // 5000 pages already in the -wal file and 108 new ones need a second 32 KiB -shm step.
  const walBytes = 32 + 5000 * (4096 + 24);
  const grown = estimateRequiredFree({ ...allocated, walBytes }, { includeBackup: false }).database;
  expect(grown - none).toBe(2 * 32768);
});

test("migrations that rebuild nothing still need room for the backup", () => {
  const measurements = { ...MEASUREMENTS, rebuildsTables: false, regeneratesSearch: false };
  // No new copies: only the -wal header, 64 KiB fixed room and one 32 KiB -shm step.
  expect(estimateRequiredFree(measurements, { includeBackup: true })).toEqual({
    database: 2 * (32 + 98304),
    backup: 2 * 409600,
    temporary: 0,
  });
});

function structureBytes(db: Database, table: string) {
  return db
    .query<{ bytes: number }>(
      `SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN
        (SELECT name FROM sqlite_schema WHERE tbl_name = $table)`,
    )
    .get({ $table: table })!.bytes;
}

function withoutDbstat(db: Database): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          if (sql.includes("dbstat")) {
            throw new Error("no such table: dbstat");
          }
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("measurements match the database, with separators counted from comment rows", () => {
  withDatabase((db) => {
    seedBaseline(db);
    // A wrong task.comment_count must not change the count.
    db.exec("UPDATE task SET comment_count = 99 WHERE id = 't1'");

    const measured = measureSpace(db, [migration(2, ["label"], true)]);
    const pageSize = db.query<{ page_size: number }>("PRAGMA page_size").get()!.page_size;
    const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
    const separatorBytes = new TextEncoder().encode(SEARCH_COMMENT_SEPARATOR).length;

    expect(measured.pageSize).toBe(pageSize);
    expect(measured.databaseBytes).toBe(pageSize * pageCount);
    expect(measured.taskCount).toBe(3);
    // ids 6 + titles 16 + comments 11 + one separator (t1 has two comments)
    expect(measured.searchSourceBytes).toBe(6 + 16 + 11 + separatorBytes);
    expect(measured.rebuiltTableBytes).toBe(structureBytes(db, "label"));
    expect(measured.searchIndexBytes).toBe(
      ["data", "idx", "content", "docsize", "config"]
        .map((suffix) => structureBytes(db, `task_search_${suffix}`))
        .reduce((total, bytes) => total + bytes, 0),
    );
    expect(measured.walBytes).toBe(statSync(`${db.query<{ file: string }>("SELECT file FROM pragma_database_list").get()!.file}-wal`).size);
    expect(measured.shmBytes).toBeGreaterThan(0);
    expect(measured.rebuildsTables).toBe(true);
    expect(measured.regeneratesSearch).toBe(true);
  });
});

test("multibyte text counts in bytes", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = measureSpace(db, []).searchSourceBytes;
    db.exec("UPDATE task SET title = 'Café' WHERE id = 't3'"); // 'Third' (5 bytes) becomes 5 bytes
    db.exec("UPDATE task SET title = 'Ünïcödé' WHERE id = 't2'"); // 'Second' (6 bytes) becomes 11 bytes
    expect(measureSpace(db, []).searchSourceBytes - before).toBe(5 - 5 + 11 - 6);
  });
});

test("only pending migrations are measured", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA user_version = 2");
    const migrations = [migration(2, ["task"], true), migration(3, ["label"])];
    const measured = measureSpace(db, migrations);

    expect(measured.rebuiltTableBytes).toBe(structureBytes(db, "label"));
    expect(measured.regeneratesSearch).toBe(false);
    expect(measured.searchIndexBytes).toBe(0);

    db.exec("PRAGMA user_version = 3");
    expect(measureSpace(db, migrations).rebuildsTables).toBe(false);
  });
});

test("the whole database stands in for the rebuilt tables and for the search index when dbstat is unavailable", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const measured = measureSpace(withoutDbstat(db), [migration(2, ["label", "activity"], true)]);

    expect(measured.rebuiltTableBytes).toBe(measured.databaseBytes);
    expect(measured.searchIndexBytes).toBe(measured.databaseBytes);
  });
});

const PATHS = { database: "/db", backup: "/backup", temporary: "/tmp" };
const REQUIRED = { database: 1000, backup: 500, temporary: 300 };
const space = (availableBytes: number, device: number): FreeSpace => ({
  availableBytes,
  blockBytes: 512,
  device,
});

test("each filesystem is checked on its own and shared ones combine their allowances", () => {
  const separate = { "/db": space(1024, 1), "/backup": space(512, 2), "/tmp": space(512, 3) };
  expect(() => assertFreeSpace(PATHS, REQUIRED, (path) => separate[path as keyof typeof separate]!)).not.toThrow();

  // Backup and temporary share a device: 800 rounds up to 1024, more than the 512 available.
  const shared = { "/db": space(1024, 1), "/backup": space(512, 2), "/tmp": space(512, 2) };
  expect(() => assertFreeSpace(PATHS, REQUIRED, (path) => shared[path as keyof typeof shared]!)).toThrow(
    "Not enough free disk space at /backup, /tmp: 1024 bytes are required and 512 are available",
  );
});

test("insufficient space names the path, the required and the available bytes", () => {
  const read = (path: string) => (path === "/db" ? space(1000, 1) : space(10000, 2));
  expect(() => assertFreeSpace(PATHS, REQUIRED, read)).toThrow(
    "Not enough free disk space at /db: 1024 bytes are required and 1000 are available",
  );
});

test("unknown free space names the path and the required bytes", () => {
  const read = (path: string) => (path === "/backup" ? null : space(10000, 1));
  expect(() => assertFreeSpace(PATHS, REQUIRED, read)).toThrow(
    "The free disk space at /backup is unknown, and 500 bytes are required",
  );
});

test("work that saves no backup reads no backup directory", () => {
  const { backup: _, ...withoutBackup } = PATHS;
  const readPaths: Array<string> = [];
  const read = (path: string) => {
    readPaths.push(path);
    return space(512, 1);
  };

  // 1000 + 300 rounds up to 1536.
  expect(() => assertFreeSpace(withoutBackup, { ...REQUIRED, backup: 0 }, read)).toThrow(
    "Not enough free disk space at /db, /tmp: 1536 bytes are required and 512 are available",
  );
  expect(readPaths).toEqual(["/db", "/tmp"]);
});

test("the default reader reports the free space of a real directory", () => {
  withDirectory((directory) => {
    const real = readFreeSpace(directory)!;
    expect(real.availableBytes).toBeGreaterThan(0);
    expect(real.blockBytes).toBeGreaterThan(0);
    expect(readFreeSpace(`${directory}/missing`)).toBeNull();
  });
});
