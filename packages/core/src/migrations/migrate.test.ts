import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { classifyDatabase } from "./classify";
import { migrateDatabase, MigrationRefusedError } from "./migrate";
import { rebuildTask, seedBaseline, snapshot, withDirectory } from "./testing";

const PLENTY_OF_SPACE = { availableBytes: 2 ** 40, blockBytes: 4096, device: 1 };

const upgradeTask: Migration = { version: 2, name: "rebuild task", rebuilds: ["task"], apply: rebuildTask };
const options = (directory: string, migrations: ReadonlyArray<Migration>) => ({
  backup: { directory: join(directory, "backups"), client: "test", version: "1.2.3" },
  migrations,
  readFreeSpace: () => PLENTY_OF_SPACE,
});

function withDatabase(directory: string, prepare: (db: Database) => void) {
  const path = join(directory, "zinn.sqlite");
  const db = openDatabase(path);

  try {
    db.exec("PRAGMA journal_mode = WAL");
    prepare(db);
  } finally {
    db.close();
  }

  return path;
}

function snapshotOf(path: string) {
  const db = openDatabase(path);

  try {
    return snapshot(db);
  } finally {
    db.close();
  }
}

function versionedAt(version: number) {
  return (db: Database) => {
    seedBaseline(db);
    db.exec(`PRAGMA user_version = ${version}`);
  };
}

test("classifies every state without creating anything", () => {
  withDirectory((directory) => {
    const absent = join(directory, "absent.sqlite");
    expect(classifyDatabase(absent, [])).toEqual({ state: "absent", version: 0, latestVersion: 1 });
    expect(existsSync(absent)).toBe(false);

    const emptyDir = join(directory, "empty");
    mkdirSync(emptyDir);
    const empty = withDatabase(emptyDir, () => {});
    expect(classifyDatabase(empty, []).state).toBe("empty");

    const unmarkedDir = join(directory, "unmarked");
    mkdirSync(unmarkedDir);
    const unmarked = withDatabase(unmarkedDir, (db) => {
      seedBaseline(db);
      db.exec("PRAGMA user_version = 0");
    });
    expect(classifyDatabase(unmarked, [])).toEqual({ state: "unmarked", version: 0, latestVersion: 1 });

    const databaseDirectory = join(directory, "database");
    mkdirSync(databaseDirectory);
    const database = withDatabase(databaseDirectory, seedBaseline);
    expect(classifyDatabase(database, []).state).toBe("current");
    expect(classifyDatabase(database, [upgradeTask])).toEqual({
      state: "older",
      version: 1,
      latestVersion: 2,
    });

    const newerDir = join(directory, "newer");
    mkdirSync(newerDir);
    const newer = withDatabase(newerDir, versionedAt(5));
    expect(classifyDatabase(newer, [upgradeTask])).toEqual({ state: "newer", version: 5, latestVersion: 2 });

    expect(readdirSync(directory).sort()).toEqual(["database", "empty", "newer", "unmarked"]);
  });
});

test("an absent database is refused and no file or directory is created", () => {
  withDirectory((directory) => {
    const path = join(directory, "data", "zinn.sqlite");

    expect(() => migrateDatabase(path, options(directory, []))).toThrow(MigrationRefusedError);
    expect(readdirSync(directory)).toEqual([]);
  });
});

test("an empty database is refused and left empty", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, () => {});
    const before = snapshotOf(path);

    expect(() => migrateDatabase(path, options(directory, [upgradeTask]))).toThrow(MigrationRefusedError);
    expect(snapshotOf(path)).toEqual(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});

test("an unmarked database is refused and keeps schema, data and version", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, (db) => {
      seedBaseline(db);
      db.exec("PRAGMA user_version = 0");
    });
    const before = snapshotOf(path);

    expect(() => migrateDatabase(path, options(directory, [upgradeTask]))).toThrow(
      /no schema version.*adopted/,
    );
    expect(snapshotOf(path)).toEqual(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});

test("a newer database is refused with both versions and the running build, and left unchanged", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, versionedAt(7));
    const before = snapshotOf(path);

    expect(() => migrateDatabase(path, options(directory, [upgradeTask]))).toThrow(
      /version 7.*test 1\.2\.3.*version 2/,
    );
    expect(snapshotOf(path)).toEqual(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});

test("a current database is a no-op with no backup", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, seedBaseline);
    const before = snapshotOf(path);

    expect(migrateDatabase(path, options(directory, []))).toEqual({
      databasePath: path,
      previousVersion: 1,
      finalVersion: 1,
      changed: false,
      backupPath: null,
    });
    expect(snapshotOf(path)).toEqual(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});

test("an older database is upgraded after a backup that is kept and still opens", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, seedBaseline);
    const before = snapshotOf(path);

    const result = migrateDatabase(path, options(directory, [upgradeTask]));

    // An upgraded database reports the path SQLite resolved, which differs where the folder is a symlink.
    expect(result).toMatchObject({
      databasePath: realpathSync(path),
      previousVersion: 1,
      finalVersion: 2,
      changed: true,
    });
    expect(result.backupPath).not.toBeNull();
    expect(snapshotOf(path).version).toBe(2);
    expect(snapshotOf(path).rows).toEqual(before.rows);

    const backup = openDatabase(result.backupPath!);
    try {
      expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(snapshot(backup)).toEqual(before);
    } finally {
      backup.close();
    }
  });
});

test("a failed upgrade leaves the database as it was and keeps the backup", () => {
  withDirectory((directory) => {
    const path = withDatabase(directory, seedBaseline);
    const before = snapshotOf(path);
    const failing: Migration = {
      version: 2,
      name: "fails",
      rebuilds: [],
      apply() {
        throw new Error("migration broke");
      },
    };

    expect(() => migrateDatabase(path, options(directory, [failing]))).toThrow("migration broke");
    expect(snapshotOf(path)).toEqual(before);
    expect(readdirSync(join(directory, "backups"))).toHaveLength(1);
  });
});
