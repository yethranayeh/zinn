import type { Database, SqliteDriver } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { driver as bunDriver } from "../sqlite/bun.ts";
import { openWith, SqliteError } from "../sqlite/database";
import { BASELINE_VERSION, createBaseline } from "./baseline";
import { assertMigrationOrder, MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import {
  count,
  foreignKeys,
  rebuildTask,
  schemaObjects,
  seedBaseline,
  snapshot,
  withDatabase,
  withDirectory,
} from "./testing";

type Suppressing = { suppressed?: unknown };

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

const CHILD_TABLES = ["task_relations", "task_label", "comment"];

test("rebuilding a parent table keeps every child row and link", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA legacy_alter_table = OFF");
    const before = snapshot(db);
    const targetsBefore = CHILD_TABLES.map((table) =>
      db.query("SELECT * FROM pragma_foreign_key_list($table)").all({ $table: table }),
    );
    const rebuild = migration(2, rebuildTask, ["task"]);

    upgradeSchema(db, [rebuild]);

    const after = snapshot(db);
    expect(after.version).toBe(2);
    for (const table of ["task", ...CHILD_TABLES]) {
      expect(after.rows[table]).toEqual(before.rows[table]!);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(foreignKeys(db)).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(rebuild.calls.count).toBe(1);
    expect(CHILD_TABLES.map((table) =>
      db.query("SELECT * FROM pragma_foreign_key_list($table)").all({ $table: table }),
    )).toEqual(targetsBefore);

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

test.each([true, false])(
  "an unsafe parent rename rolls back with empty children: %p",
  (emptyChildren) => {
    withDatabase((db) => {
      seedBaseline(db);
      db.exec("PRAGMA legacy_alter_table = OFF");
      if (emptyChildren) {
        db.exec("DELETE FROM task_label");
      }
      const before = snapshot(db);
      const unsafeRebuild = migration(2, (db) => {
        db.exec(`
          ALTER TABLE label RENAME TO label_old;
          CREATE TABLE label (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            color TEXT NOT NULL);
          INSERT INTO label SELECT * FROM label_old;
          DROP TABLE label_old;
        `);
      }, ["label"]);

      let thrown: unknown;
      try {
        upgradeSchema(db, [unsafeRebuild]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("task_label");
      expect((thrown as Error).message).toContain("label_old");
      expect(snapshot(db)).toEqual(before);
      expect(foreignKeys(db)).toBe(1);
      expect(db.inTransaction).toBe(false);
      expect(unsafeRebuild.calls.count).toBe(1);
    });
  },
);

test("parent tables may appear later in the chain and use a different identifier case", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const addChild = migration(2, (db) => {
      db.exec("CREATE TABLE extra_child (parent_id TEXT REFERENCES EXTRA_PARENT(id))");
    });
    const addParent = migration(3, (db) => {
      db.exec("CREATE TABLE extra_parent (id TEXT PRIMARY KEY)");
    });

    upgradeSchema(db, [addChild, addParent]);

    expect(readSchemaVersion(db)).toBe(3);
    db.exec("INSERT INTO extra_parent VALUES ('p'); INSERT INTO extra_child VALUES ('p')");
    expect(count(db, "extra_child")).toBe(1);
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

test("getDb() creates a fresh database at the baseline schema and version", () => {
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
    expect(initialized.version).toBe(BASELINE_VERSION);

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
