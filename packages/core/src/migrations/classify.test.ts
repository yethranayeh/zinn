import type { Database } from "../sqlite/database";

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { resolveDatabasePath } from "../database-path";
import { readSchemaVersionWithoutWaiting } from "./classify";
import { withDirectory } from "./testing";

const VERSION = 7;
// Where the database file's header stores the version. https://www.sqlite.org/fileformat.html
const USER_VERSION_OFFSET = 60;
const PROMPT_MS = 1000;
const READ_ONLY_DIRECTORY_MODE = 0o555;
const WRITABLE_DIRECTORY_MODE = 0o755;
const GARBAGE = "not a database ".repeat(500);

function read(path: string) {
  return readSchemaVersionWithoutWaiting(resolveDatabasePath(path));
}

function hash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectPrompt(path: string, expected: ReadonlyArray<number | null>) {
  const start = performance.now();
  const version = read(path);

  expect(performance.now() - start).toBeLessThan(PROMPT_MS);
  expect(expected).toContain(version);
}

/** A WAL database whose version sits only in the WAL, kept there by the open writer. */
function withWalVersion(check: (path: string, writer: Database, directory: string) => void) {
  withDirectory((directory) => {
    const path = join(realpathSync(directory), "zinn.sqlite");
    const writer = openDatabase(path);

    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE item (value INTEGER)");
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      writer.exec(`PRAGMA user_version = ${VERSION}`);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

      check(path, writer, realpathSync(directory));
    } finally {
      writer.close();
    }
  });
}

/** Copies the database and WAL with no connection on the copy, as after a crash. */
function copyWithoutConnections(path: string, directory: string) {
  const copyDirectory = join(directory, "crashed");
  mkdirSync(copyDirectory);
  const copy = join(copyDirectory, "zinn.sqlite");
  copyFileSync(path, copy);
  copyFileSync(`${path}-wal`, `${copy}-wal`);
  return copy;
}

function expectReadLeavesFilesAlone(path: string) {
  const mainBefore = hash(path);
  const walBefore = hash(`${path}-wal`);
  const walSizeBefore = statSync(`${path}-wal`).size;

  expect(read(path)).toBe(VERSION);

  expect(hash(path)).toBe(mainBefore);
  expect(statSync(`${path}-wal`).size).toBeGreaterThanOrEqual(walSizeBefore);
  expect(hash(`${path}-wal`)).toBe(walBefore);
}

test("a version committed only to the WAL is read while another connection holds it there", () => {
  withWalVersion((path, writer) => {
    expect(readFileSync(path).readUInt32BE(USER_VERSION_OFFSET)).toBe(0);

    expect(read(path)).toBe(VERSION);

    writer.exec(`PRAGMA user_version = ${VERSION + 1}`);
    expect(read(path)).toBe(VERSION + 1);
  });
});

test("the read changes neither the main file nor the WAL while another connection is open", () => {
  withWalVersion((path) => {
    expectReadLeavesFilesAlone(path);
  });
});

test("the read closes as the last connection without checkpointing a WAL left by a crash", () => {
  withWalVersion((path, _writer, directory) => {
    expectReadLeavesFilesAlone(copyWithoutConnections(path, directory));
  });
});

test("a WAL-mode database with no WAL left reads and stays usable afterwards", () => {
  withWalVersion((path, writer) => {
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close();
    const mainBefore = hash(path);

    expect(read(path)).toBe(VERSION);
    expect(hash(path)).toBe(mainBefore);

    const next = openDatabase(path);
    try {
      next.query("INSERT INTO item VALUES (?)").run(1);
      expect(next.query("PRAGMA user_version").get()).toEqual({ user_version: VERSION });
      expect(next.query("SELECT COUNT(*) AS count FROM item").get()).toEqual({ count: 1 });
    } finally {
      next.close();
    }
  });
});

test("a WAL reader answers promptly past a writer's BEGIN EXCLUSIVE", () => {
  withWalVersion((path, writer) => {
    writer.exec("BEGIN EXCLUSIVE");

    try {
      expectPrompt(path, [null, VERSION]);
    } finally {
      writer.exec("ROLLBACK");
    }
  });
});

test("WAL exclusive locking mode gives null at once", () => {
  withWalVersion((path, writer) => {
    writer.exec("PRAGMA locking_mode = EXCLUSIVE");
    writer.exec(`PRAGMA user_version = ${VERSION + 1}`);

    expectPrompt(path, [null]);
  });
});

test("a rollback-journal database under an exclusive lock gives null at once", () => {
  withDirectory((directory) => {
    const path = join(realpathSync(directory), "zinn.sqlite");
    const holder = openDatabase(path);

    try {
      holder.exec(`PRAGMA user_version = ${VERSION}`);
      holder.exec("BEGIN EXCLUSIVE");

      expectPrompt(path, [null]);

      holder.exec("ROLLBACK");
      expect(read(path)).toBe(VERSION);
    } finally {
      holder.close();
    }
  });
});

test("a garbage file gives null and stays as it was", () => {
  withDirectory((directory) => {
    const path = join(directory, "zinn.sqlite");
    writeFileSync(path, GARBAGE);

    expect(read(path)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(GARBAGE);
  });
});

test("a missing file gives null and is not created", () => {
  withDirectory((directory) => {
    const path = join(directory, "missing.sqlite");

    expect(read(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });
});

test("a folder in place of the database gives null", () => {
  withDirectory((directory) => {
    expect(read(directory)).toBeNull();
  });
});

test("a database with no version gives 0", () => {
  withDirectory((directory) => {
    const path = join(directory, "zinn.sqlite");
    const db = openDatabase(path);
    db.exec("CREATE TABLE item (value INTEGER)");
    db.close();

    expect(read(path)).toBe(0);
  });
});

test("a WAL database in a folder it cannot write does not throw", () => {
  withWalVersion((path, _writer, directory) => {
    const copy = copyWithoutConnections(path, directory);
    const copyDirectory = join(directory, "crashed");
    chmodSync(copyDirectory, READ_ONLY_DIRECTORY_MODE);

    try {
      expectPrompt(copy, [null, VERSION]);
    } finally {
      chmodSync(copyDirectory, WRITABLE_DIRECTORY_MODE);
    }
  });
});
