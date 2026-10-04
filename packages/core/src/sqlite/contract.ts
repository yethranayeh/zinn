/**
 * Contract checks shared by both adapters
 * Everything stays in memory *except* checks that need two connections
 *  to one file, which use a temporary directory removed afterwards.
 */
import type { Database, OpenOptions, SqliteDriver } from "./database.ts";

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWith, sqliteCodeName, SqliteError } from "./database.ts";

type Adapter = {
  driver: SqliteDriver;
  openDatabase(path: string, options?: OpenOptions): Database;
};
type DefineTest = (name: string, fn: () => void) => unknown;

function withDatabase(adapter: Adapter, check: (db: Database) => void) {
  const db = adapter.openDatabase(":memory:");

  try {
    check(db);
  } finally {
    db.close();
  }
}

function withDirectory(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-sqlite-contract-"));

  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A binding or API error: thrown before SQLite runs, with no SQLite code. */
function isBindingError(error: unknown) {
  return error instanceof TypeError && !(error instanceof SqliteError) && !("code" in error);
}

/** An error the wrapper raises for a database it will not use, with no SQLite or driver code. */
function isStateError(error: unknown, message: string) {
  return (
    error instanceof Error &&
    !(error instanceof SqliteError) &&
    !("code" in error) &&
    error.message === message
  );
}

function isClosedError(error: unknown) {
  return isStateError(error, "The database is closed");
}

function isTransactionLostError(error: unknown) {
  return isStateError(
    error,
    "SQLite rolled back this transaction after an earlier error, so no more statements can run in it",
  );
}

function assertSqliteError(error: unknown, code: string, errcode: number) {
  assert.ok(error instanceof SqliteError);
  assert.equal(error.code, code);
  assert.equal(error.errcode, errcode);
  assert.ok(error.cause instanceof Error);
  assert.ok(!(error.cause instanceof SqliteError));
  assert.equal(error.message, error.cause.message);
  return true;
}

function count(db: Database, table: string) {
  return db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

export function defineContractChecks(test: DefineTest, adapter: Adapter) {
  test("named bindings keep their $ prefix, may repeat, and accept explicit null", () => {
    withDatabase(adapter, (db) => {
      const statement = db.query<{ a: number; again: number; b: null }, { $a: number; $b: null }>(
        "SELECT $a AS a, $a + 1 AS again, $b AS b",
      );

      assert.deepEqual(statement.get({ $a: 1, $b: null }), { a: 1, again: 2, b: null });
      assert.deepEqual(statement.all({ $a: 5, $b: null }), [{ a: 5, again: 6, b: null }]);
    });
  });

  test("binding mistakes throw before SQLite runs, without a SQLite code", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value TEXT)");
      const named = db.query("INSERT INTO item (value) VALUES ($value)");
      const positional = db.query("SELECT ? AS a, ? AS b");

      assert.throws(() => named.run({}), isBindingError);
      assert.throws(() => named.run(), isBindingError);
      assert.throws(() => named.run({ value: "bare" }), isBindingError);
      assert.throws(() => named.run({ $value: "x", $extra: "y" }), isBindingError);
      assert.throws(() => named.run({ $value: undefined as unknown as null }), isBindingError);
      assert.throws(() => positional.get(1), isBindingError);
      assert.throws(() => positional.get(1, 2, 3), isBindingError);
      assert.throws(() => positional.get(1, undefined as unknown as null), isBindingError);
      assert.throws(() => db.query("SELECT :value").get({ ":value": 1 }), isBindingError);
      assert.throws(() => db.query("SELECT ?1").get(1), isBindingError);
      assert.equal(count(db, "item"), 0);

      named.run({ $value: null });
      assert.deepEqual(positional.get(1, null), { a: 1, b: null });
    });
  });

  test("integral numbers within 52 bits bind as INTEGER, other numbers as REAL", () => {
    withDatabase(adapter, (db) => {
      const positional = db.query<{ type: string }>("SELECT typeof(?) AS type");
      const named = db.query<{ type: string }, { $value: number }>("SELECT typeof($value) AS type");
      const boundTypes = (value: number) => [
        positional.get(value)!.type,
        named.get({ $value: value })!.type,
      ];

      for (const value of [5, 0, -7, 1_700_000_000_000, 2 ** 51 - 1, -(2 ** 51)]) {
        assert.deepEqual(boundTypes(value), ["integer", "integer"], `${value}`);
      }
      for (const value of [1.5, -0, 2 ** 51]) {
        assert.deepEqual(boundTypes(value), ["real", "real"], `${value}`);
      }

      db.exec("CREATE TABLE item (value)");
      db.query("INSERT INTO item VALUES (?)").run(5);
      assert.deepEqual(
        db.query("SELECT value, typeof(value) AS type, value || '' AS text FROM item").get(),
        { value: 5, type: "integer", text: "5" },
      );
      assert.deepEqual(db.query("SELECT json_object('value', $value) AS json").get({ $value: 5 }), {
        json: '{"value":5}',
      });
    });
  });

  test("integers read back as numbers, and one beyond the safe range throws instead of rounding", () => {
    withDatabase(adapter, (db) => {
      assert.deepEqual(
        db
          .query(
            "SELECT 9007199254740991 AS max, -9007199254740991 AS min, 5 AS small, 2.5 AS real, NULL AS none, COUNT(*) AS count",
          )
          .get(),
        {
          max: Number.MAX_SAFE_INTEGER,
          min: Number.MIN_SAFE_INTEGER,
          small: 5,
          real: 2.5,
          none: null,
          count: 1,
        },
      );

      const isIntegerRangeError = (error: unknown) =>
        error instanceof RangeError && !("code" in error) && error.message.includes("column big");

      for (const big of ["9007199254740992", "-9007199254740992", "9223372036854775807"]) {
        const statement = db.query(`SELECT 1 AS small, ${big} AS big`);
        assert.throws(() => statement.get(), isIntegerRangeError, big);
        assert.throws(() => statement.all(), isIntegerRangeError, big);
      }

      // A bigint binds exactly, and reading it as text keeps every digit.
      assert.deepEqual(db.query("SELECT CAST(? AS TEXT) AS text").get(9007199254740993n), {
        text: "9007199254740993",
      });
    });
  });

  test("placeholders inside literals, quoted identifiers and comments are not parameters", () => {
    withDatabase(adapter, (db) => {
      const statement = db.query(`SELECT 'it''s $text ?' AS [$quoted?], ? AS [bracket $name ?]
        -- $line ?
        /* $block ? */`);

      assert.throws(() => statement.get(), isBindingError);
      assert.deepEqual(statement.get(7), { "$quoted?": "it's $text ?", "bracket $name ?": 7 });
    });
  });

  test("double quotes are refused outside literals and comments", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (name TEXT)");

      assert.throws(() => db.query(`SELECT "name" FROM item`), isBindingError);
      assert.throws(() => db.query(`SELECT "nope" FROM item`), isBindingError);
      assert.throws(() => db.query(`SELECT 1 AS "alias"`), isBindingError);
      assert.throws(() => db.query(`CREATE INDEX i ON item("nope")`), isBindingError);
      assert.throws(() => db.query(`SELECT 'a' -- note\n, "b"`), isBindingError);

      assert.deepEqual(
        db
          .query(`SELECT 'say "hi"' AS [quoted "name"], 'it''s "x"' AS \`back"tick\` -- "comment"
            /* "block" */`)
          .get(),
        { 'quoted "name"': 'say "hi"', 'back"tick': `it's "x"` },
      );

      // A double quote inside a bound value is data, as in an FTS5 phrase query.
      db.exec("CREATE VIRTUAL TABLE search USING fts5(body)");
      db.query("INSERT INTO search (body) VALUES (?)").run("hello brave world");
      const match = db.query<{ body: string }>("SELECT body FROM search WHERE search MATCH ?");
      assert.deepEqual(match.get('"hello brave"'), { body: "hello brave world" });
    });
  });

  test("parameter names the scanner cannot read exactly are refused", () => {
    withDatabase(adapter, (db) => {
      for (const sql of [
        "SELECT $a$b",
        "SELECT $na\u00efve",
        "SELECT $\u00e9",
        "SELECT $a::b",
        "SELECT $::a",
        "SELECT $a(x)",
        "SELECT $$",
      ]) {
        assert.throws(() => db.query(sql), isBindingError, sql);
      }

      assert.deepEqual(db.query("SELECT $a_1 AS a, $A2 AS b").get({ $a_1: 1, $A2: 2 }), {
        a: 1,
        b: 2,
      });
      assert.deepEqual(db.query("SELECT ($a)+1 AS a, $b || 'x' AS b").get({ $a: 1, $b: "y" }), {
        a: 2,
        b: "yx",
      });
    });
  });

  test("NaN and Infinity are refused when binding", () => {
    withDatabase(adapter, (db) => {
      const positional = db.query("SELECT ? AS value");
      const named = db.query("SELECT $value AS value");

      for (const value of [NaN, Infinity, -Infinity]) {
        assert.throws(() => positional.get(value), isBindingError, `${value}`);
        assert.throws(() => named.get({ $value: value }), isBindingError, `${value}`);
      }

      assert.deepEqual(positional.get(1.5), { value: 1.5 });
      assert.deepEqual(named.get({ $value: Number.MAX_VALUE }), { value: Number.MAX_VALUE });
    });
  });

  test("results: a missing row is null, rows are ordinary objects, run returns nothing", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('a');");

      assert.equal(db.query("SELECT * FROM item WHERE value = ?").get("missing"), null);
      assert.equal(Object.getPrototypeOf(db.query("SELECT * FROM item").get()), Object.prototype);
      assert.equal(
        Object.getPrototypeOf(db.query("SELECT * FROM item").all()[0]),
        Object.prototype,
      );
      assert.equal(db.query("INSERT INTO item VALUES (?)").run("b"), undefined);
      assert.equal(db.exec("INSERT INTO item VALUES ('c')"), undefined);
      assert.equal(count(db, "item"), 3);
    });
  });

  test("query prepares each SQL string once and reuses the statement", () => {
    withDatabase(adapter, (db) => {
      assert.equal(db.query("SELECT 1"), db.query("SELECT 1"));
      assert.notEqual(db.query("SELECT 1"), db.query("SELECT 2"));
    });
  });

  test("immediate transactions commit, report their state, and roll back on a throw", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value TEXT)");
      const insert = db.query("INSERT INTO item VALUES (?)");

      const result = db
        .transaction(() => {
          assert.equal(db.inTransaction, true);
          insert.run("kept");
          return "done";
        })
        .immediate();
      assert.equal(result, "done");
      assert.equal(db.inTransaction, false);

      const failure = new Error("callback failed");
      assert.throws(
        () =>
          db
            .transaction(() => {
              insert.run("discarded");
              throw failure;
            })
            .immediate(),
        (error) => error === failure,
      );
      assert.equal(db.inTransaction, false);
      assert.deepEqual(db.query("SELECT value FROM item").all(), [{ value: "kept" }]);
    });
  });

  test("a nested transaction runs in a savepoint inside the outer one", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value TEXT)");
      const insert = db.query("INSERT INTO item VALUES (?)");

      db.transaction(() => {
        insert.run("outer");
        assert.throws(() =>
          db
            .transaction(() => {
              insert.run("inner");
              throw new Error("inner failed");
            })
            .immediate(),
        );
        db.transaction(() => insert.run("inner kept")).immediate();
        assert.equal(db.inTransaction, true);
      }).immediate();

      assert.deepEqual(db.query("SELECT value FROM item ORDER BY value").all(), [
        { value: "inner kept" },
        { value: "outer" },
      ]);
    });
  });

  test("a failed COMMIT rolls back the still-open transaction and throws the COMMIT error", () => {
    withDatabase(adapter, (db) => {
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);

      assert.throws(
        () =>
          db
            .transaction(() => {
              db.query("INSERT INTO child VALUES (?)").run(1);
              assert.equal(db.inTransaction, true);
            })
            .immediate(),
        (error) => assertSqliteError(error, "SQLITE_CONSTRAINT_FOREIGNKEY", 787),
      );
      assert.equal(db.inTransaction, false);
      assert.equal(count(db, "child"), 0);
    });
  });

  test("after SQLite rolls back by itself, the original error is thrown", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value BLOB)");
      const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
      db.exec(`PRAGMA max_page_count = ${pageCount + 2}`);
      let stillInTransaction: boolean | null = null;

      assert.throws(
        () =>
          db
            .transaction(() => {
              try {
                db.query("INSERT INTO item VALUES (randomblob(1000000))").run();
              } finally {
                stillInTransaction = db.inTransaction;
              }
            })
            .immediate(),
        (error) => assertSqliteError(error, "SQLITE_FULL", 13),
      );
      assert.equal(stillInTransaction, false);
      assert.equal(db.inTransaction, false);
      assert.equal(count(db, "item"), 0);
    });
  });

  test("after SQLite rolls back a transaction by itself, nothing runs in it until it ends", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value BLOB)");
      const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
      db.exec(`PRAGMA max_page_count = ${pageCount + 2}`);
      const insert = db.query("INSERT INTO item VALUES (?)");

      assert.throws(
        () =>
          db
            .transaction(() => {
              insert.run("outer");
              assert.throws(
                () =>
                  db
                    .transaction(() => {
                      db.query("INSERT INTO item VALUES (randomblob(1000000))").run();
                    })
                    .immediate(),
                (error) => assertSqliteError(error, "SQLITE_FULL", 13),
              );

              // Without the guard, these would run outside any transaction and commit one by one.
              assert.throws(() => insert.run("after"), isTransactionLostError);
              assert.throws(() => db.query("SELECT 1").get(), isTransactionLostError);
              assert.throws(() => db.exec("SELECT 1"), isTransactionLostError);
              assert.throws(
                () => db.transaction(() => insert.run("nested after")).immediate(),
                isTransactionLostError,
              );
            })
            .immediate(),
        isTransactionLostError,
      );

      assert.equal(db.inTransaction, false);
      assert.equal(count(db, "item"), 0);
      insert.run("later");
      assert.equal(count(db, "item"), 1);
    });
  });

  test("when ROLLBACK also fails, the original error is thrown and the rollback error kept", () => {
    const rollbackFailure = new Error("rollback failed");
    let failRollback = true;
    const driver: SqliteDriver = {
      ...adapter.driver,
      connect(path, options) {
        const connection = adapter.driver.connect(path, options);
        return {
          prepare: (sql) => connection.prepare(sql),
          exec(sql) {
            if (sql === "ROLLBACK" && failRollback) {
              failRollback = false;
              throw rollbackFailure;
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
    const db = openWith(driver, ":memory:");

    try {
      const failure = new Error("callback failed");
      assert.throws(
        () =>
          db
            .transaction(() => {
              throw failure;
            })
            .immediate(),
        (error) =>
          error === failure && (error as { suppressed?: unknown }).suppressed === rollbackFailure,
      );
    } finally {
      db.exec("ROLLBACK");
      db.close();
    }
  });

  test("SQLite errors keep their extended code, symbolic name and driver cause", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (value TEXT UNIQUE NOT NULL)");
      db.query("INSERT INTO item VALUES (?)").run("a");

      assert.throws(
        () => db.query("INSERT INTO item VALUES (?)").run("a"),
        (error) =>
          assertSqliteError(error, "SQLITE_CONSTRAINT_UNIQUE", 2067) &&
          (error as Error).message === "UNIQUE constraint failed: item.value",
      );
      assert.throws(
        () => db.query("INSERT INTO item VALUES (?)").run(null),
        (error) => assertSqliteError(error, "SQLITE_CONSTRAINT_NOTNULL", 1299),
      );
      assert.throws(
        () => db.query("SELECT * FROM missing"),
        (error) => assertSqliteError(error, "SQLITE_ERROR", 1),
      );
    });

    assert.equal(sqliteCodeName(261), "SQLITE_BUSY_RECOVERY");
    assert.equal(sqliteCodeName(1546), "SQLITE_IOERR_TRUNCATE");
    assert.equal(sqliteCodeName(4618), "SQLITE_IOERR_SHMOPEN");
    assert.equal(sqliteCodeName(526), "SQLITE_CANTOPEN_ISDIR");
    assert.equal(sqliteCodeName(3091), "SQLITE_CONSTRAINT_DATATYPE");
    // An extended code SQLite has not defined (100 << 8 | SQLITE_IOERR) falls back to SQLITE_IOERR.
    assert.equal(sqliteCodeName(25610), "SQLITE_IOERR");
  });

  test("lock contention between two connections is SQLITE_BUSY, and a stale snapshot SQLITE_BUSY_SNAPSHOT", () => {
    withDirectory((directory) => {
      const path = join(directory, "contract.sqlite");
      const a = adapter.openDatabase(path);
      const b = adapter.openDatabase(path);

      try {
        a.exec("PRAGMA journal_mode = WAL; CREATE TABLE item (value INTEGER);");
        b.exec("PRAGMA busy_timeout = 25");
        assert.deepEqual(b.query("PRAGMA busy_timeout").get(), { timeout: 25 });

        a.exec("BEGIN IMMEDIATE");
        assert.throws(
          () => b.exec("BEGIN IMMEDIATE"),
          (error) =>
            assertSqliteError(error, "SQLITE_BUSY", 5) &&
            (error as Error).message === "database is locked",
        );
        a.exec("ROLLBACK");

        b.exec("BEGIN");
        b.query("SELECT * FROM item").all();
        a.query("INSERT INTO item VALUES (?)").run(1);
        assert.throws(
          () => b.query("INSERT INTO item VALUES (?)").run(2),
          (error) => assertSqliteError(error, "SQLITE_BUSY_SNAPSHOT", 517),
        );
        b.exec("ROLLBACK");
      } finally {
        a.close();
        b.close();
      }
    });
  });

  test("close releases the database file after statements ran", () => {
    withDirectory((directory) => {
      const path = join(directory, "contract.sqlite");
      const a = adapter.openDatabase(path);
      a.exec("PRAGMA journal_mode = WAL; CREATE TABLE item (value INTEGER);");
      a.query("SELECT * FROM item").all();
      a.query("SELECT * FROM item WHERE value = ?").get(1);
      a.close();

      const b = adapter.openDatabase(path);

      try {
        // Leaving WAL mode needs the only connection; a half-closed one would make this SQLITE_BUSY.
        assert.deepEqual(b.query("PRAGMA journal_mode = DELETE").get(), { journal_mode: "delete" });
      } finally {
        b.close();
      }
    });
  });

  test("closing a closed database does nothing", () => {
    const db = adapter.openDatabase(":memory:");
    db.close();
    assert.doesNotThrow(() => db.close());
  });

  test("using a closed database throws the same error on both runtimes", () => {
    const db = adapter.openDatabase(":memory:");
    db.exec("CREATE TABLE item (value INTEGER)");
    const select = db.query("SELECT * FROM item");
    const insert = db.query("INSERT INTO item VALUES (?)");
    db.close();

    assert.throws(() => select.get(), isClosedError);
    assert.throws(() => select.all(), isClosedError);
    assert.throws(() => insert.run(1), isClosedError);
    assert.throws(() => db.query("SELECT * FROM item"), isClosedError);
    assert.throws(() => db.query("SELECT 1"), isClosedError);
    assert.throws(() => db.exec("SELECT 1"), isClosedError);
    assert.throws(() => db.inTransaction, isClosedError);
    assert.throws(() => db.transaction(() => 1).immediate(), isClosedError);
  });

  test("query_only and read-only connections refuse writes", () => {
    withDirectory((directory) => {
      const path = join(directory, "contract.sqlite");
      const writer = adapter.openDatabase(path);

      try {
        writer.exec("PRAGMA query_only = ON");
        assert.throws(
          () => writer.exec("CREATE TABLE item (value INTEGER)"),
          (error) => assertSqliteError(error, "SQLITE_READONLY", 8),
        );
        writer.exec("PRAGMA query_only = OFF; CREATE TABLE item (value INTEGER);");
      } finally {
        writer.close();
      }

      const reader = adapter.openDatabase(path, { readonly: true });

      try {
        assert.equal(count(reader, "item"), 0);
        assert.throws(
          () => reader.query("INSERT INTO item VALUES (?)").run(1),
          (error) => assertSqliteError(error, "SQLITE_READONLY", 8),
        );
      } finally {
        reader.close();
      }
    });
  });

  test("foreign keys start off and can be switched outside a transaction", () => {
    withDatabase(adapter, (db) => {
      const foreignKeys = () => db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get();

      assert.deepEqual(foreignKeys(), { foreign_keys: 0 });
      db.exec("PRAGMA foreign_keys = ON");
      assert.deepEqual(foreignKeys(), { foreign_keys: 1 });
      db.exec("PRAGMA foreign_keys = OFF");
      assert.deepEqual(foreignKeys(), { foreign_keys: 0 });
    });
  });

  test("FTS5 with unicode61 remove_diacritics 2 matches without diacritics", () => {
    withDatabase(adapter, (db) => {
      db.exec(`CREATE VIRTUAL TABLE search USING fts5(
        id UNINDEXED, title, tokenize = 'unicode61 remove_diacritics 2')`);
      db.query("INSERT INTO search (id, title) VALUES ($id, $title)").run({
        $id: "1",
        $title: "Crème brûlée in Zürich",
      });

      assert.deepEqual(db.query("SELECT id FROM search WHERE search MATCH ?").all("creme zurich"), [
        { id: "1" },
      ]);
    });
  });

  test("an independent connection snapshots committed WAL data while another holds BEGIN IMMEDIATE", () => {
    withDirectory((directory) => {
      const path = join(directory, "contract.sqlite");
      const snapshotPath = join(directory, "snapshot.sqlite");
      const a = adapter.openDatabase(path);
      const b = adapter.openDatabase(path);

      try {
        a.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE item (value INTEGER); INSERT INTO item VALUES (1);`);
        assert.ok(existsSync(`${path}-wal`));
        a.exec("BEGIN IMMEDIATE");

        b.query("VACUUM INTO ?").run(snapshotPath);
        assert.equal(a.inTransaction, true);
        a.exec("ROLLBACK");
      } finally {
        a.close();
        b.close();
      }

      const snapshot = adapter.openDatabase(snapshotPath, { readonly: true });

      try {
        assert.deepEqual(snapshot.query("SELECT value FROM item").all(), [{ value: 1 }]);
        assert.deepEqual(snapshot.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    });
  });
}
