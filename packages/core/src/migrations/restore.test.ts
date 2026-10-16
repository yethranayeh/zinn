import type { Database, SqliteDriver } from "../sqlite/database";
import type { Migration } from "./registry";
import type { LockWait } from "./upgrade";
import type { RestoreOptions } from "./restore";

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import * as dbBackup from "../db/backup";
import { driver as bunDriver } from "../sqlite/bun.ts";
import { openWith } from "../sqlite/database";
import { applyConnectionSettings } from "../connection";
import { checkBackup, restoreBackup, restoreDatabase, RestoreRefusedError } from "./restore";
import { readSchemaVersion } from "./runner";
import { foreignKeys, rebuildTask, schemaObjects, seedBaseline, withDirectory } from "./testing";

const PLENTY_OF_SPACE = { availableBytes: 2 ** 40, blockBytes: 4096, device: 1 };
const BUILD = { client: "test", version: "1.2.3" };
/** The client and version written into the name of every backup these tests restore from. */
const MAKER = { client: "cli", version: "0.40.0" };
const SHORT_BUDGET_MS = 150;
const NEWER_VERSION = 2;

const rebuildTaskMigration: Migration = {
  version: 2,
  name: "rebuild task",
  rebuilds: ["task"],
  apply: rebuildTask,
};

/** A version 2 that adds every kind of schema object the baseline lacks. */
const addObjectsMigration: Migration = {
  version: 2,
  name: "add objects",
  rebuilds: [],
  apply(db) {
    db.exec(`
      CREATE INDEX task_title ON task (title);
      CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL);
      CREATE VIEW open_task AS SELECT id FROM task WHERE archived_at IS NULL;
      CREATE TRIGGER note_touches_project AFTER INSERT ON note
        BEGIN UPDATE project SET updated_at = updated_at + 1; END;
    `);
  },
};

function options(directory: string, overrides: Partial<RestoreOptions> = {}): RestoreOptions {
  return {
    backup: { directory: join(directory, "backups"), ...BUILD },
    migrations: [],
    readFreeSpace: () => PLENTY_OF_SPACE,
    ...overrides,
  };
}

/** Creates a database file in WAL mode, as getDb() would, and lets prepare fill it. */
function makeDatabase(path: string, prepare: (db: Database) => void) {
  const db = openDatabase(path);

  try {
    db.exec("PRAGMA journal_mode = WAL");
    prepare(db);
  } finally {
    db.close();
  }

  return path;
}

function withOpen<T>(path: string, read: (db: Database) => T): T {
  const db = openDatabase(path);

  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * The version, schema and every row with its rowid. The search index's shadow tables are left out:
 *  rebuilding the index from the same text may lay them out differently.
 */
function databaseState(db: Database) {
  const tables = db
    .query<{ name: string }>(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  const rows = Object.fromEntries(
    tables.map((name) => [name, db.query(`SELECT rowid, * FROM ${name} ORDER BY rowid`).all()]),
  );

  return { version: readSchemaVersion(db), schema: schemaObjects(db), rows };
}

function readDatabaseState(path: string) {
  return withOpen(path, databaseState);
}

function searchIds(db: Database, words: string) {
  return db
    .query<{ task_id: string }>(
      "SELECT task_id FROM task_search WHERE task_search MATCH $words ORDER BY task_id",
    )
    .all({ $words: words })
    .map(({ task_id }) => task_id);
}

function expectHealthy(db: Database) {
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // FTS5 checks its index against the stored text. https://www.sqlite.org/fts5.html#the_integrity_check_command
  db.exec("INSERT INTO task_search (task_search) VALUES ('integrity-check')");
}

/** The baseline seed with the project renamed and the last task archived. */
function seedSource(db: Database) {
  seedBaseline(db);
  db.exec(`
    UPDATE project SET key = 'SRC', name = 'Source';
    UPDATE task SET archived_at = 11 WHERE id = 't3';
    INSERT INTO task_search (task_id, title, description, comments) VALUES ('t3', 'Third', 'gadget', '');
  `);
}

/** The baseline seed with other rows, so a restore has something to replace. */
function seedLive(db: Database) {
  seedBaseline(db);
  db.exec(`
    UPDATE project SET key = 'LIV', task_count = 4;
    INSERT INTO task (id, project_id, column_id, number, title, comment_count, created_at, updated_at)
      VALUES ('t4', 'p1', 'c2', 4, 'Live only', 0, 20, 20);
    INSERT INTO task_search (task_id, title, description, comments) VALUES ('t4', 'Live only', 'widget', '');
    DELETE FROM comment WHERE id = 'm3';
    UPDATE task SET comment_count = 0 WHERE id = 't2';
  `);
}

/** A backup of a fresh database made by `prepare`, named the way the backup command names it. */
function backupOf(directory: string, prepare: (db: Database) => void) {
  const source = makeDatabase(join(directory, `source-${readdirSync(directory).length}.sqlite`), prepare);
  return dbBackup.create(source, join(directory, "made"), MAKER).path;
}

function savedBackups(directory: string) {
  const saved = join(directory, "backups");
  return existsSync(saved) ? readdirSync(saved) : [];
}

function catchError(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("Expected an error");
}

test("a backup at the same version replaces the database, keeping rows, rowids, timestamps, counters and search", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, seedSource);
    const liveBefore = readDatabaseState(live);
    const backupState = readDatabaseState(backupPath);

    const result = restoreDatabase(live, backupPath, options(directory));

    expect(result).toEqual({
      databasePath: realpathSync(live),
      previousVersion: 1,
      restoredVersion: 1,
      backupPath: expect.any(String),
    });
    expect(readDatabaseState(live)).toEqual(backupState);
    expect(backupState.rows.task).toContainEqual(expect.objectContaining({ id: "t3", archived_at: 11 }));
    expect(backupState.rows.project).toEqual([expect.objectContaining({ key: "SRC", task_count: 3 })]);
    withOpen(live, (db) => {
      expectHealthy(db);
      expect(searchIds(db, "three")).toEqual(["t2"]);
      expect(searchIds(db, "gadget")).toEqual(["t3"]);
      expect(searchIds(db, "widget")).toEqual([]);
    });

    // The replaced database was saved as an ordinary backup.
    expect(savedBackups(directory)).toHaveLength(1);
    expect(readDatabaseState(result.backupPath!)).toEqual(liveBefore);
  });
});

test("the backup taken before a restore restores the database back", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const liveBefore = readDatabaseState(live);
    const first = restoreDatabase(live, backupOf(directory, seedSource), options(directory));

    const second = restoreDatabase(live, first.backupPath!, options(directory));

    expect(readDatabaseState(live)).toEqual(liveBefore);
    withOpen(live, (db) => {
      expectHealthy(db);
      expect(searchIds(db, "widget")).toEqual(["t4"]);
    });
    expect(savedBackups(directory)).toHaveLength(2);
    expect(second.backupPath).not.toBe(first.backupPath);
  });
});

test("restores into a database newer than this build", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), (db) => {
      seedLive(db);
      db.exec(`PRAGMA user_version = ${NEWER_VERSION}`);
    });
    const backupPath = backupOf(directory, seedSource);

    const result = restoreDatabase(live, backupPath, options(directory));

    expect(result).toMatchObject({ previousVersion: NEWER_VERSION, restoredVersion: 1 });
    expect(readDatabaseState(live)).toEqual(readDatabaseState(backupPath));
    expect(readDatabaseState(result.backupPath!).version).toBe(NEWER_VERSION);
  });
});

test("restores into a database older than this build, and into one without a schema version", () => {
  withDirectory((directory) => {
    const migrations = [rebuildTaskMigration];
    const backupPath = backupOf(directory, (db) => {
      seedSource(db);
      db.exec("PRAGMA user_version = 2");
    });

    const older = makeDatabase(join(directory, "older.sqlite"), seedLive);
    expect(restoreDatabase(older, backupPath, options(directory, { migrations }))).toMatchObject({
      previousVersion: 1,
      restoredVersion: 2,
    });
    expect(readDatabaseState(older)).toEqual(readDatabaseState(backupPath));

    const unmarked = makeDatabase(join(directory, "unmarked.sqlite"), (db) => {
      seedLive(db);
      db.exec("PRAGMA user_version = 0");
    });
    const result = restoreDatabase(unmarked, backupPath, options(directory, { migrations }));
    expect(result).toMatchObject({ previousVersion: 0, restoredVersion: 2 });
    expect(readDatabaseState(unmarked)).toEqual(readDatabaseState(backupPath));
    expect(readDatabaseState(result.backupPath!).version).toBe(0);
  });
});

test("an older backup is restored at its own version, without upgrading it", () => {
  withDirectory((directory) => {
    const migrations = [rebuildTaskMigration];
    const live = makeDatabase(join(directory, "zinn.sqlite"), (db) => {
      seedLive(db);
      db.exec("PRAGMA user_version = 2");
    });
    const backupPath = backupOf(directory, seedSource);

    const result = restoreDatabase(live, backupPath, options(directory, { migrations }));

    expect(result).toMatchObject({ previousVersion: 2, restoredVersion: 1 });
    expect(readDatabaseState(live)).toEqual(readDatabaseState(backupPath));
  });
});

test("indexes, views, triggers and AUTOINCREMENT counters are restored, and the replaced database's are dropped", () => {
  withDirectory((directory) => {
    const migrations = [addObjectsMigration];
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, (db) => {
      seedSource(db);
      addObjectsMigration.apply(db);
      db.exec(`
        INSERT INTO note (text) VALUES ('kept'), ('deleted');
        DELETE FROM note WHERE text = 'deleted';
        PRAGMA user_version = 2;
      `);
    });

    const result = restoreDatabase(live, backupPath, options(directory, { migrations }));

    expect(readDatabaseState(live)).toEqual(readDatabaseState(backupPath));
    withOpen(live, (db) => {
      expectHealthy(db);
      expect(db.query("SELECT name, seq FROM sqlite_sequence").all()).toEqual([
        { name: "note", seq: 2 },
      ]);
      expect(db.query("SELECT id FROM open_task ORDER BY id").all()).toEqual([
        { id: "t1" },
        { id: "t2" },
      ]);
      db.exec("INSERT INTO note (text) VALUES ('new')");
      expect(db.query("SELECT id FROM note WHERE text = 'new'").get()).toEqual({ id: 3 });
      expect(db.query("SELECT updated_at FROM project").get()).toEqual({ updated_at: 4 });
    });

    // Restoring the version 1 database drops the version 2 objects again.
    restoreDatabase(live, result.backupPath!, options(directory, { migrations }));
    const restored = readDatabaseState(live);
    expect(restored.version).toBe(1);
    expect(restored.schema.map(({ name }) => name)).not.toContain("open_task");
    expect(restored.schema.map(({ name }) => name)).not.toContain("task_title");
    expect(restored.schema.map(({ name }) => name)).not.toContain("note");
    withOpen(live, (db) => {
      expect(db.query("SELECT name, seq FROM sqlite_sequence").all()).toEqual([]);
    });
  });
});

test("a backup whose columns are in another order is restored, as SQLite stored its schema", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, (db) => {
      seedSource(db);
      // A rename makes SQLite store the new name in double quotes.
      db.exec(`
        CREATE TABLE new_label (color TEXT NOT NULL, description TEXT, name TEXT NOT NULL UNIQUE, id TEXT PRIMARY KEY);
        INSERT INTO new_label (id, name, description, color) SELECT id, name, description, color FROM label;
        DROP TABLE label;
        ALTER TABLE new_label RENAME TO label;
      `);
    });

    restoreDatabase(live, backupPath, options(directory));

    const restored = readDatabaseState(live);
    expect(restored).toEqual(readDatabaseState(backupPath));
    expect(Object.keys(restored.rows.label![0]!)).toEqual(["rowid", "color", "description", "name", "id"]);
    expect(restored.rows.label).toHaveLength(2);
    withOpen(live, expectHealthy);
  });
});

test("a backup that cannot be restored is refused, and the database and backups are left as they were", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const before = readDatabaseState(live);

    const textFile = join(directory, "notes.sqlite");
    writeFileSync(textFile, "not a database ".repeat(200));

    const emptyFile = join(directory, "empty.sqlite");
    writeFileSync(emptyFile, "");

    const brokenIndex = backupOf(directory, seedSource);
    const { rootpage, pageSize } = withOpen(brokenIndex, (db) => ({
      rootpage: db
        .query<{ rootpage: number }>(
          "SELECT rootpage FROM sqlite_schema WHERE name = 'sqlite_autoindex_label_2'",
        )
        .get()!.rootpage,
      pageSize: db.query<{ page_size: number }>("PRAGMA page_size").get()!.page_size,
    }));
    const bytes = readFileSync(brokenIndex);
    const page = bytes.subarray((rootpage - 1) * pageSize, rootpage * pageSize);
    // The label name index no longer matches the label table.
    page.write("unusex", page.indexOf("unused"));
    writeFileSync(brokenIndex, bytes);

    const otherApp = makeDatabase(join(directory, "other.sqlite"), (db) => {
      db.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, text TEXT); PRAGMA user_version = 1");
    });
    const unmarked = backupOf(directory, (db) => {
      seedSource(db);
      db.exec("PRAGMA user_version = 0");
    });
    const newer = backupOf(directory, (db) => {
      seedSource(db);
      db.exec(`PRAGMA user_version = ${NEWER_VERSION}`);
    });
    const newerUnnamed = join(directory, "newer-copy.sqlite");
    writeFileSync(newerUnnamed, readFileSync(newer));

    const cases = [
      { path: join(directory, "missing.sqlite"), message: "There is no file at" },
      { path: textFile, message: "is damaged or is not a SQLite database (file is not a database)" },
      { path: brokenIndex, message: "failed SQLite's integrity check (row 2 missing from index sqlite_autoindex_label_2)" },
      { path: otherApp, message: "is not a Zinn database" },
      { path: emptyFile, message: "has no schema version" },
      { path: unmarked, message: "has no schema version" },
      {
        path: newer,
        message: `has schema version 2, but this build (test 1.2.3) reaches only version 1, so nothing was restored. It was made by cli 0.40.0; restore it with that version or a newer one`,
      },
      { path: newerUnnamed, message: "so nothing was restored. Restore it with a newer Zinn version" },
    ];

    for (const { path, message } of cases) {
      const error = catchError(() => restoreDatabase(live, path, options(directory)));

      expect(error).toBeInstanceOf(RestoreRefusedError);
      expect((error as Error).message).toContain(path);
      expect((error as Error).message).toContain(message);
    }

    expect(readDatabaseState(live)).toEqual(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});

test("restores onto a missing database by creating it, with no backup of a replaced database", () => {
  withDirectory((directory) => {
    const backupPath = backupOf(directory, seedSource);
    const live = join(directory, "store", "data", "zinn.sqlite");

    const result = restoreDatabase(live, backupPath, options(directory));

    expect(result).toEqual({
      databasePath: realpathSync(live),
      previousVersion: 0,
      restoredVersion: 1,
      backupPath: null,
    });
    expect(readDatabaseState(live)).toEqual(readDatabaseState(backupPath));
    withOpen(live, expectHealthy);
    expect(savedBackups(directory)).toEqual([]);
  });
});

test("a refused restore onto a missing database creates nothing", () => {
  withDirectory((directory) => {
    const live = join(directory, "store", "data", "zinn.sqlite");

    expect(() => restoreDatabase(live, join(directory, "missing.sqlite"), options(directory))).toThrow(
      RestoreRefusedError,
    );
    expect(existsSync(join(directory, "store"))).toBe(false);
  });
});

test("a failure while copying rows rolls back, keeps its error and the backup, and leaves the database as it was", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, seedSource);
    const before = readDatabaseState(live);
    const failure = new Error("injected copy failure");
    const failingDriver: SqliteDriver = {
      ...bunDriver,
      connect(path, connectOptions) {
        const connection = bunDriver.connect(path, connectOptions);
        return {
          prepare: (sql) => connection.prepare(sql),
          exec(sql) {
            if (sql.startsWith("INSERT INTO main.`comment`")) {
              throw failure;
            }

            connection.exec(sql);
          },
          get inTransaction() {
            return connection.inTransaction;
          },
          close: () => connection.close(),
        };
      },
    };
    const db = openWith(failingDriver, live);

    try {
      applyConnectionSettings(db);
      db.exec("PRAGMA foreign_keys = ON");
      const checked = checkBackup(backupPath, [], BUILD);

      expect(catchError(() => restoreBackup(db, checked, options(directory)))).toBe(failure);

      expect(db.inTransaction).toBe(false);
      expect(foreignKeys(db)).toBe(1);
      expect(db.query("SELECT name FROM pragma_database_list").all()).toEqual([{ name: "main" }]);
    } finally {
      db.close();
    }

    expect(readDatabaseState(live)).toEqual(before);
    const saved = savedBackups(directory);
    expect(saved).toHaveLength(1);
    expect(readDatabaseState(join(directory, "backups", saved[0]!))).toEqual(before);
  });
});

test("a backup whose rows point to missing rows is rolled back before committing", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const before = readDatabaseState(live);
    const backupPath = backupOf(directory, (db) => {
      seedSource(db);
      db.exec(`
        PRAGMA foreign_keys = OFF;
        INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
          VALUES ('m9', 'gone', 1, 'orphan', 12, 12);
      `);
    });

    expect(() => restoreDatabase(live, backupPath, options(directory))).toThrow(
      "The restore would leave 1 rows whose foreign keys point to missing rows (comment to task)",
    );
    expect(readDatabaseState(live)).toEqual(before);
    expect(savedBackups(directory)).toHaveLength(1);
  });
});

test("a backup with an empty child referencing a missing table rolls back before committing", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const before = readDatabaseState(live);
    const backupPath = backupOf(directory, (db) => {
      seedSource(db);
      db.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = OFF;
        DELETE FROM task_label;
        ALTER TABLE label RENAME TO label_old;
        CREATE TABLE label (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, color TEXT NOT NULL);
        INSERT INTO label SELECT * FROM label_old;
        DROP TABLE label_old;
      `);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    const backupBefore = readDatabaseState(backupPath);
    const checked = checkBackup(backupPath, [], BUILD);

    withOpen(live, (db) => {
      db.exec("PRAGMA foreign_keys = ON");
      const error = catchError(() => restoreBackup(db, checked, options(directory)));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("task_label");
      expect((error as Error).message).toContain("label_old");
      expect(databaseState(db)).toEqual(before);
      expect(foreignKeys(db)).toBe(1);
      expect(db.inTransaction).toBe(false);
    });
    expect(readDatabaseState(backupPath)).toEqual(backupBefore);
    const backups = savedBackups(directory);
    expect(backups).toHaveLength(1);
    expect(readDatabaseState(join(directory, "backups", backups[0]!))).toEqual(before);
  });
});

test("a connection opened before the restore reads the restored database afterwards", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, seedSource);

    withOpen(live, (other) => {
      expect(other.query("SELECT key FROM project").all()).toEqual([{ key: "LIV" }]);

      restoreDatabase(live, backupPath, options(directory));

      expect(other.query("SELECT key FROM project").all()).toEqual([{ key: "SRC" }]);
      expect(searchIds(other, "gadget")).toEqual(["t3"]);
      expect(databaseState(other)).toEqual(readDatabaseState(backupPath));
    });
  });
});

test("a restore that cannot get the write lock in time stops before changing or saving anything", () => {
  withDirectory((directory) => {
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);
    const backupPath = backupOf(directory, seedSource);
    const before = readDatabaseState(live);
    const waits: Array<LockWait> = [];

    withOpen(live, (other) => {
      other.exec("BEGIN IMMEDIATE");

      try {
        expect(() =>
          restoreDatabase(
            live,
            backupPath,
            options(directory, { budgetMs: SHORT_BUDGET_MS, onWait: (wait) => waits.push(wait) }),
          ),
        ).toThrow(
          /^Waited \d+\.\d seconds for another writer to finish with the database at .+, so this restore stopped and applied no changes\. Retry once the other writer finishes\.$/,
        );
      } finally {
        other.exec("ROLLBACK");
      }
    });

    expect(waits).toEqual([{ databasePath: realpathSync(live), budgetMs: SHORT_BUDGET_MS }]);
    expect(readDatabaseState(live)).toEqual(before);
    expect(savedBackups(directory)).toEqual([]);
  });
});

test("backup file names give the client and version that made them", () => {
  expect(dbBackup.readBackupFileName("/b/2026-10-06T12-30-05Z-cli-0.40.0-1a2b3c4d.sqlite")).toEqual({
    client: "cli",
    version: "0.40.0",
  });
  expect(
    dbBackup.readBackupFileName("2026-10-06T12-30-05Z-zinn-tui-1.0.0-beta.2-1a2b3c4d.sqlite"),
  ).toEqual({ client: "zinn-tui", version: "1.0.0-beta.2" });
  expect(dbBackup.readBackupFileName("2026-10-06T12-30-05Z-test-unknown-1a2b3c4d.sqlite")).toBeNull();
  expect(dbBackup.readBackupFileName("database.sqlite")).toBeNull();
});

test("the backup a restore saves is named like any other backup", () => {
  withDirectory((directory) => {
    mkdirSync(join(directory, "backups"));
    const live = makeDatabase(join(directory, "zinn.sqlite"), seedLive);

    const { backupPath } = restoreDatabase(live, backupOf(directory, seedSource), options(directory));

    expect(dbBackup.readBackupFileName(backupPath!)).toEqual(BUILD);
  });
});
