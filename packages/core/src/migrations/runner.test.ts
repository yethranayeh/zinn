import type { Database, SqliteDriver } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "#sqlite";

import { driver as bunDriver } from "../sqlite/bun.ts";
import { openWith, SqliteError } from "../sqlite/database";
import { BASELINE_VERSION, createBaseline } from "./baseline";
import { assertMigrationOrder, MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
type Suppressing = { suppressed?: unknown };

function withDirectory(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-migrations-"));

  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A database file set up the way getDb() sets up its connection. */
function withDatabase(check: (db: Database) => void, open = (path: string) => openDatabase(path)) {
  withDirectory((directory) => {
    const db = open(join(directory, "zinn.sqlite"));

    try {
      db.exec("PRAGMA busy_timeout = 30000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      check(db);
    } finally {
      db.close();
    }
  });
}

/** Fails the next exec() of each SQL string in failures with its error, once. */
function withFailingExec(failures: Map<string, Error>, check: (db: Database) => void) {
  const driver: SqliteDriver = {
    ...bunDriver,
    connect(path, options) {
      const connection = bunDriver.connect(path, options);
      return {
        prepare: (sql) => connection.prepare(sql),
        exec(sql) {
          const failure = failures.get(sql);
          if (failure != null) {
            failures.delete(sql);
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

  withDatabase(check, (path) => openWith(driver, path));
}

/** A database at the baseline version holding a project with tasks, and the tasks' child rows. */
function seedBaseline(db: Database) {
  createSchema(db, []);
  db.exec(`
    INSERT INTO project (id, key, name, task_count, created_at, updated_at)
      VALUES ('p1', 'APP', 'App', 3, 1, 1);
    INSERT INTO project_column (id, project_id, name, column_order)
      VALUES ('c1', 'p1', 'Todo', 'a0'), ('c2', 'p1', 'Done', 'a1');
    INSERT INTO task (id, project_id, column_id, number, title, priority, comment_count, created_at, updated_at)
      VALUES ('t1', 'p1', 'c1', 1, 'First', 'high', 2, 2, 2),
             ('t2', 'p1', 'c1', 2, 'Second', NULL, 1, 3, 3),
             ('t3', 'p1', 'c2', 3, 'Third', 'low', 0, 4, 4);
    INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
      VALUES ('r1', 't1', 't2', 'subtask', 5), ('r2', 't2', 't3', 'dependency', 6);
    INSERT INTO label (id, name, color) VALUES ('l1', 'bug', 'red'), ('l2', 'unused', 'blue');
    INSERT INTO task_label (task_id, label_id) VALUES ('t1', 'l1'), ('t3', 'l1');
    INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('m1', 't1', 1, 'one', 7, 7), ('m2', 't1', 2, 'two', 8, 8), ('m3', 't2', 1, 'three', 9, 9);
    INSERT INTO task_search (task_id, title, description, comments)
      VALUES ('t1', 'First', NULL, 'one two'), ('t2', 'Second', NULL, 'three');
    INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action)
      VALUES ('a1', 10, 'Test Human', 'human', 'task', 't1', 'create');
  `);
}

function schemaObjects(db: Database) {
  return db
    .query<SchemaObject>("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
    .all();
}

/** The schema, version and every row, to compare a database before and after a failed upgrade. */
function snapshot(db: Database) {
  const schema = schemaObjects(db);
  const tables = schema.filter(({ type, name }) => type === "table" && !name.startsWith("sqlite_"));
  const rows = Object.fromEntries(
    tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name}`).all()]),
  );

  return { version: readSchemaVersion(db), schema, rows };
}

function count(db: Database, table: string) {
  return db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

function foreignKeys(db: Database) {
  return db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get()!.foreign_keys;
}

function migration(version: number, apply: (db: Database) => void, rebuilds: Array<string> = []) {
  const calls = { count: 0 };
  const definition: Migration = {
    version,
    name: `test migration ${version}`,
    rebuilds,
    apply(db) {
      calls.count++;
      apply(db);
    },
  };

  return Object.assign(definition, { calls });
}

/** The baseline task table without its priority CHECK, rebuilt the way SQLite documents. */
function rebuildTask(db: Database) {
  db.exec(`
    CREATE TABLE new_task (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      column_id      TEXT NOT NULL REFERENCES project_column(id),
      number         INTEGER NOT NULL,
      title          TEXT NOT NULL,
      description    TEXT,
      priority       TEXT,
      task_order     TEXT,
      comment_count  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      archived_at    INTEGER);
    INSERT INTO new_task SELECT * FROM task;
    DROP TABLE task;
    ALTER TABLE new_task RENAME TO task;
  `);
}

const CHILD_TABLES = ["task_relations", "task_label", "comment"];

test("rebuilding a parent table keeps every child row and link", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const rebuild = migration(2, rebuildTask, ["task"]);

    upgradeSchema(db, [rebuild]);

    const after = snapshot(db);
    expect(after.version).toBe(2);
    for (const table of ["task", ...CHILD_TABLES]) {
      expect(after.rows[table]).toEqual(before.rows[table]!);
    }
    const taskSql = after.schema.find(({ name }) => name === "task")!.sql;
    expect(taskSql).not.toContain("CHECK");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(foreignKeys(db)).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(rebuild.calls.count).toBe(1);

    // The child tables still reference task and enforce it.
    expect(() => db.exec("DELETE FROM task WHERE id = 't1'")).not.toThrow();
    expect(count(db, "comment")).toBe(1);
    expect(() =>
      db.exec(`INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
        VALUES ('m9', 'missing', 1, 'x', 1, 1)`),
    ).toThrow(SqliteError);
  });
});

test("the same rebuild with foreign keys switched off inside a transaction deletes the child rows", () => {
  // The failure the runner prevents: inside a transaction the pragma does nothing.
  withDatabase((db) => {
    seedBaseline(db);

    db.transaction(() => {
      db.exec("PRAGMA foreign_keys = OFF");
      rebuildTask(db);
    }).immediate();

    expect(count(db, "task")).toBe(3);
    for (const table of CHILD_TABLES) {
      expect(count(db, table)).toBe(0);
    }
  });
});

test("a failing migration leaves schema, version and data unchanged and keeps its error", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const failure = new Error("planned migration failure");
    const addColumn = migration(2, (db) => {
      db.exec("ALTER TABLE project ADD COLUMN extra TEXT");
      db.exec("UPDATE project SET name = 'Changed', extra = 'x'");
      rebuildTask(db);
    }, ["task"]);
    const failing = migration(3, () => {
      throw failure;
    });

    let thrown: unknown;
    try {
      upgradeSchema(db, [addColumn, failing]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect((thrown as Suppressing).suppressed).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
    expect(db.inTransaction).toBe(false);
    // Never replayed.
    expect(addColumn.calls.count).toBe(1);
    expect(failing.calls.count).toBe(1);
  });
});

/**
 * A full disk rolls back the whole transaction after a statement without a statement journal,
 *  such as a one-row INSERT ... VALUES, and only the statement otherwise.
 * @link https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction
 */
test.each([
  {
    statement: `INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action, changes)
      VALUES ('big', 1, 'Test Human', 'human', 'task', 't1', 'create', randomblob(1000000))`,
    rolledBackBySqlite: true,
  },
  { statement: "UPDATE project SET extra = randomblob(1000000)", rolledBackBySqlite: false },
])(
  "a full disk keeps SQLITE_FULL and changes nothing (rolled back by SQLite: $rolledBackBySqlite)",
  ({ statement, rolledBackBySqlite }) => {
    withDatabase((db) => {
      seedBaseline(db);
      const before = snapshot(db);
      const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
      db.exec(`PRAGMA max_page_count = ${pageCount + 2}`);
      const observed: { inTransaction: boolean | null } = { inTransaction: null };
      const filling = migration(2, (db) => {
        db.exec("ALTER TABLE project ADD COLUMN extra BLOB");
        try {
          db.exec(statement);
        } finally {
          observed.inTransaction = db.inTransaction;
        }
      });

      let thrown: unknown;
      try {
        upgradeSchema(db, [filling]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SqliteError);
      expect((thrown as SqliteError).code).toBe("SQLITE_FULL");
      expect(observed.inTransaction).toBe(!rolledBackBySqlite);
      // No ROLLBACK was attempted on a transaction SQLite had already ended.
      expect((thrown as Suppressing).suppressed).toBeUndefined();
      expect(snapshot(db)).toEqual(before);
      expect(foreignKeys(db)).toBe(1);
      expect(db.inTransaction).toBe(false);
    });
  },
);

test("a failed COMMIT is rolled back and its error kept", () => {
  const commitFailure = new Error("planned COMMIT failure");
  const failures = new Map<string, Error>();

  withFailingExec(failures, (db) => {
    seedBaseline(db);
    const before = snapshot(db);
    failures.set("COMMIT", commitFailure);

    expect(() => upgradeSchema(db, [migration(2, rebuildTask, ["task"])])).toThrow(commitFailure);
    expect(snapshot(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
    expect(db.inTransaction).toBe(false);
  });
});

test("when ROLLBACK and restoring foreign keys also fail, the original error keeps both", () => {
  const failure = new Error("planned migration failure");
  const rollbackFailure = new Error("planned ROLLBACK failure");

  const failures = new Map<string, Error>();

  withFailingExec(failures, (db) => {
    seedBaseline(db);
    const before = snapshot(db);
    failures.set("ROLLBACK", rollbackFailure);

    let thrown: unknown;
    try {
      upgradeSchema(db, [
        migration(2, (db) => {
          rebuildTask(db);
          throw failure;
        }, ["task"]),
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect((thrown as Suppressing).suppressed).toBe(rollbackFailure);
    // The transaction is still open, so switching foreign keys back on did nothing.
    const restoreFailure = (rollbackFailure as Suppressing).suppressed;
    expect(restoreFailure).toBeInstanceOf(Error);
    expect((restoreFailure as Error).message).toContain("Foreign keys could not be switched back");

    db.exec("ROLLBACK");
    expect(snapshot(db)).toEqual(before);
  });
});

test("rows whose foreign keys point to missing rows abort the upgrade", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const orphaning = migration(2, (db) => {
      db.exec(`INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
        VALUES ('orphan', 'missing', 1, 'x', 1, 1)`);
    });

    expect(() => upgradeSchema(db, [orphaning])).toThrow(
      "The schema upgrade would leave 1 rows whose foreign keys point to missing rows (comment to task)",
    );
    expect(snapshot(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
  });
});

test("a rebuild that changes its table's row count aborts the upgrade", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const losingRow = migration(2, (db) => {
      db.exec(`
        CREATE TABLE new_label (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          color TEXT NOT NULL);
        INSERT INTO new_label SELECT * FROM label WHERE id <> 'l2';
        DROP TABLE label;
        ALTER TABLE new_label RENAME TO label;
      `);
    }, ["label"]);

    expect(() => upgradeSchema(db, [losingRow])).toThrow(
      "Migration 2 (test migration 2) left 1 rows in label, which had 2",
    );
    expect(snapshot(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
  });
});

test("foreign keys that were off stay off after an upgrade and after a failure", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA foreign_keys = OFF");

    upgradeSchema(db, [migration(2, rebuildTask, ["task"])]);
    expect(foreignKeys(db)).toBe(0);

    expect(() =>
      upgradeSchema(db, [
        migration(2, rebuildTask, ["task"]),
        migration(3, () => {
          throw new Error("planned migration failure");
        }),
      ]),
    ).toThrow("planned migration failure");
    expect(foreignKeys(db)).toBe(0);
    expect(readSchemaVersion(db)).toBe(2);
  });
});

test("only migrations after the database's version run, and a current database is left alone", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const second = migration(2, (db) => db.exec("ALTER TABLE project ADD COLUMN second TEXT"));
    const third = migration(3, (db) => db.exec("ALTER TABLE project ADD COLUMN third TEXT"));

    upgradeSchema(db, [second]);
    upgradeSchema(db, [second, third]);
    expect(readSchemaVersion(db)).toBe(3);
    expect(second.calls.count).toBe(1);
    expect(third.calls.count).toBe(1);

    const before = snapshot(db);
    upgradeSchema(db, [second, third]);
    expect(snapshot(db)).toEqual(before);
    expect(second.calls.count).toBe(1);
    expect(third.calls.count).toBe(1);
  });
});

test("an unmarked or newer database is refused unchanged", () => {
  withDatabase((db) => {
    // Today's schema without a version, as every existing database has it.
    createBaseline(db);
    const unmarked = snapshot(db);
    const step = migration(2, (db) => db.exec("ALTER TABLE project ADD COLUMN extra TEXT"));

    expect(() => upgradeSchema(db, [step])).toThrow(
      "Only schema versions 1 to 2 can be upgraded, and this database has version 0",
    );
    expect(snapshot(db)).toEqual(unmarked);

    db.exec("PRAGMA user_version = 3");
    expect(() => upgradeSchema(db, [step])).toThrow("this database has version 3");
    expect(readSchemaVersion(db)).toBe(3);
    expect(step.calls.count).toBe(0);
    expect(foreignKeys(db)).toBe(1);
  });
});

test("an upgrade cannot start inside a transaction", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const step = migration(2, rebuildTask, ["task"]);
    db.exec("BEGIN");

    expect(() => upgradeSchema(db, [step])).toThrow("must start outside a transaction");
    expect(step.calls.count).toBe(0);
    expect(foreignKeys(db)).toBe(1);
    db.exec("ROLLBACK");
  });
});

test("migration versions must follow the baseline one by one", () => {
  const noop = () => {};

  expect(() => assertMigrationOrder(MIGRATIONS)).not.toThrow();
  expect(() => assertMigrationOrder([migration(2, noop), migration(3, noop)])).not.toThrow();
  for (const versions of [[3], [2, 2], [2, 4], [3, 2], [1]]) {
    expect(() => assertMigrationOrder(versions.map((version) => migration(version, noop)))).toThrow(
      "is out of order",
    );
  }

  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const step = migration(3, noop);

    expect(() => upgradeSchema(db, [step])).toThrow("is out of order");
    expect(step.calls.count).toBe(0);
    expect(snapshot(db)).toEqual(before);
  });
});

test("a fresh database gets the baseline and every migration, ending at the latest version", () => {
  withDatabase((db) => {
    const addTable = migration(2, (db) => db.exec("CREATE TABLE extra (id TEXT PRIMARY KEY)"));
    const addColumn = migration(3, (db) => db.exec("ALTER TABLE task ADD COLUMN extra TEXT"));

    createSchema(db, [addTable, addColumn]);

    expect(readSchemaVersion(db)).toBe(3);
    const tables = schemaObjects(db).map(({ name }) => name);
    const baselineTables = [
      "project", "project_column", "task", "task_relations", "label", "task_label", "comment",
      "task_search", "activity",
    ];
    for (const table of [...baselineTables, "extra"]) {
      expect(tables).toContain(table);
    }
    const taskColumns = db.query<{ name: string }>("PRAGMA table_info(task)").all();
    expect(taskColumns.map(({ name }) => name)).toContain("extra");
    expect(foreignKeys(db)).toBe(1);
  });
});

test("the baseline is the schema getDb() creates today, and getDb() still leaves it unmarked", () => {
  withDirectory((directory) => {
    const modulePath = JSON.stringify(fileURLToPath(new URL("../db.ts", import.meta.url)));
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { getDb } from ${modulePath};
      const db = getDb();
      const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
      const version = db.query("PRAGMA user_version").get().user_version;
      db.close();
      console.log(JSON.stringify({ schema, version }));
    `], { env: { ...process.env, ZINN_DIR: directory } });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const initialized = JSON.parse(result.stdout.toString());
    expect(initialized.version).toBe(0);

    withDatabase((db) => {
      createSchema(db, []);
      expect(readSchemaVersion(db)).toBe(BASELINE_VERSION);
      expect(schemaObjects(db)).toEqual(initialized.schema);
    });
  });
});

test("a failed fresh creation leaves the database empty", () => {
  withDatabase((db) => {
    const failure = new Error("planned migration failure");

    expect(() =>
      createSchema(db, [
        migration(2, () => {
          throw failure;
        }),
      ]),
    ).toThrow(failure);
    expect(schemaObjects(db)).toEqual([]);
    expect(readSchemaVersion(db)).toBe(0);
    expect(foreignKeys(db)).toBe(1);
  });
});

test("fresh creation refuses a database that already has a schema or a version", () => {
  withDatabase((db) => {
    createBaseline(db);
    const before = snapshot(db);

    expect(() => createSchema(db, [])).toThrow(
      "A schema can only be created in an empty database, and this one has",
    );
    expect(snapshot(db)).toEqual(before);
  });

  withDatabase((db) => {
    db.exec("PRAGMA user_version = 1");

    expect(() => createSchema(db, [])).toThrow("0 schema objects and version 1");
    expect(schemaObjects(db)).toEqual([]);
  });
});
