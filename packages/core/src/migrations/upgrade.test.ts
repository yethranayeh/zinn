import type { Database, SqliteDriver } from "../sqlite/database";
import type { Migration } from "./registry";
import type { FreeSpace } from "./space";
import type { LockWait, UpgradeOptions, UpgradeResult } from "./upgrade";

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { openDatabase } from "#sqlite";

import * as dbBackup from "../db/backup";
import { driver as bunDriver } from "../sqlite/bun.ts";
import { openWith, SqliteError } from "../sqlite/database";
import { createBaseline } from "./baseline";
import { readSchemaVersion } from "./runner";
import { readDatabaseFile } from "./space";
import {
  count,
  foreignKeys,
  rebuildTask,
  seedBaseline,
  snapshot,
  withDatabase,
} from "./testing";
import { upgradeDatabase, withMigrationLock } from "./upgrade";

type Suppressing = { suppressed?: unknown };

// withDatabase sets this busy timeout, and the lock must leave it as it found it.
const CALLER_BUSY_TIMEOUT_MS = 30_000;
const SHORT_BUDGET_MS = 150;
// Generous room for scheduling, so the timing checks only catch a budget that restarts.
const TIMING_SLACK_MS = 1_000;
// Long enough that the caller is certainly waiting when the other process commits.
const OTHER_PROCESS_HOLD_MS = 300;
// How long each concurrent upgrader's migration holds the lock, so the others wait for it.
const CONCURRENT_MIGRATION_MS = 150;
const CONCURRENT_UPGRADERS = 3;
// Owner read and execute only: the directory can be listed but no file can be created in it.
const READ_ONLY_DIRECTORY_MODE = 0o500;
const WRITABLE_DIRECTORY_MODE = 0o700;
const PLENTY_OF_SPACE: FreeSpace = { availableBytes: 2 ** 40, blockBytes: 4096, device: 1 };
const NO_SPACE: FreeSpace = { availableBytes: 0, blockBytes: 4096, device: 1 };
const CHILD_TABLES = ["task_relations", "task_label", "comment"];
// SQLite's long-standing default page limit, which lifts the limit the full-disk case sets.
const DEFAULT_MAX_PAGE_COUNT = 1073741823;

function migration(
  version: number,
  apply: (db: Database) => void = () => {},
  rebuilds: Array<string> = [],
) {
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

function databasePath(db: Database) {
  return readDatabaseFile(db)!;
}

function backupDirectory(db: Database) {
  return join(dirname(databasePath(db)), "backups");
}

function options(db: Database, overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    backup: { directory: backupDirectory(db), client: "test", version: "1.2.3" },
    migrations: [migration(2, rebuildTask, ["task"])],
    readFreeSpace: () => PLENTY_OF_SPACE,
    ...overrides,
  };
}

function busyTimeout(db: Database) {
  return db.query<{ timeout: number }>("PRAGMA busy_timeout").get()!.timeout;
}

/** A second connection to the same file, standing in for another writer. */
function withOtherConnection<T>(db: Database, check: (other: Database) => T): T {
  const other = openDatabase(databasePath(db));

  try {
    return check(other);
  } finally {
    other.close();
  }
}

function expectLockReleased(db: Database) {
  expect(db.inTransaction).toBe(false);
  withOtherConnection(db, (other) => {
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
  });
}

function backups(db: Database) {
  const directory = backupDirectory(db);
  return existsSync(directory) ? readdirSync(directory) : [];
}

/** Opens a kept backup and checks it is a valid database holding the expected snapshot. */
function expectBackupHolds(path: string, expected: ReturnType<typeof snapshot>) {
  const backup = openDatabase(path, { readonly: true });

  try {
    expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(snapshot(backup)).toEqual(expected);
  } finally {
    backup.close();
  }
}

function expectHealthy(db: Database) {
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(foreignKeys(db)).toBe(1);
  expect(busyTimeout(db)).toBe(CALLER_BUSY_TIMEOUT_MS);
  expectLockReleased(db);
}

/** A busy error as bun:sqlite raises it, so the wrapper reads its code. */
function fakeBusyError() {
  return Object.assign(new Error("database is locked"), { name: "SQLiteError", errno: 5 });
}

type ExecControl = {
  /** How many of the next BEGIN IMMEDIATE attempts report busy at once. */
  busyAttempts: number;
  /** Fails the next exec() of each SQL string with its error, once. */
  failures: Map<string, Error>;
  /** Every exec() since the last reset, in order. */
  executed: Array<string>;
};

/**
 * A database whose exec() can be made to fail. A busy BEGIN IMMEDIATE fails at once,
 *  as SQLite does when it skips its busy handler.
 */
function withControlledExec(check: (db: Database, control: ExecControl) => void) {
  const control: ExecControl = { busyAttempts: 0, failures: new Map(), executed: [] };
  const driver: SqliteDriver = {
    ...bunDriver,
    connect(path, connectOptions) {
      const connection = bunDriver.connect(path, connectOptions);
      return {
        prepare: (sql) => connection.prepare(sql),
        exec(sql) {
          control.executed.push(sql);

          if (sql === "BEGIN IMMEDIATE" && control.busyAttempts > 0) {
            control.busyAttempts--;
            throw fakeBusyError();
          }

          const failure = control.failures.get(sql);
          if (failure != null) {
            control.failures.delete(sql);
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

  withDatabase((db) => check(db, control), (path) => openWith(driver, path));
}

function catchError(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("Expected an error");
}

test("a current database is released untouched, with no backup and no wait", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const waits: Array<LockWait> = [];

    const result = upgradeDatabase(
      db,
      options(db, { migrations: [], onWait: (wait) => waits.push(wait) }),
    );

    expect(result).toEqual({
      status: "current",
      databasePath: databasePath(db),
      previousVersion: 1,
      finalVersion: 1,
      changed: false,
      backupPath: null,
    });
    expect(waits).toEqual([]);
    expect(existsSync(backupDirectory(db))).toBe(false);
    expectHealthy(db);
  });
});

test("a newer database is released untouched, with no backup", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA user_version = 3");
    const step = migration(2);

    const result = upgradeDatabase(db, options(db, { migrations: [step] }));

    expect(result).toEqual({
      status: "newer",
      databasePath: databasePath(db),
      previousVersion: 3,
      finalVersion: 3,
      changed: false,
      backupPath: null,
    });
    expect(step.calls.count).toBe(0);
    expect(existsSync(backupDirectory(db))).toBe(false);
    expect(foreignKeys(db)).toBe(1);
    expectLockReleased(db);
  });
});

test("an unmarked database is refused before any backup", () => {
  withDatabase((db) => {
    createBaseline(db);

    expect(() => upgradeDatabase(db, options(db))).toThrow("this database has version 0");
    expect(readSchemaVersion(db)).toBe(0);
    expect(existsSync(backupDirectory(db))).toBe(false);
    expect(foreignKeys(db)).toBe(1);
    expectLockReleased(db);
  });
});

test("an older database is backed up, including writes still in the WAL, then upgraded with its rows and links", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec(`INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('wal', 't3', 1, 'only in the WAL', 11, 11)`);
    const before = snapshot(db);
    const step = migration(2, rebuildTask, ["task"]);
    const waits: Array<LockWait> = [];

    const result = upgradeDatabase(
      db,
      // The real free-space reader, on this small temporary database.
      options(db, { migrations: [step], onWait: (wait) => waits.push(wait), readFreeSpace: undefined }),
    );

    expect(result).toMatchObject({
      status: "upgraded",
      databasePath: databasePath(db),
      previousVersion: 1,
      finalVersion: 2,
      changed: true,
    });
    const backupPath = result.backupPath!;
    expect(dirname(backupPath)).toBe(backupDirectory(db));
    expect(basename(backupPath)).toMatch(/Z-test-1\.2\.3-[0-9a-f]{8}\.sqlite$/);
    expect(backups(db)).toEqual([basename(backupPath)]);
    expect(waits).toEqual([]);
    expect(step.calls.count).toBe(1);
    expectBackupHolds(backupPath, before);

    const after = snapshot(db);
    expect(after.version).toBe(2);
    for (const table of ["task", ...CHILD_TABLES]) {
      expect(after.rows[table]).toEqual(before.rows[table]!);
    }
    expectHealthy(db);
  });
});

test("while the lock is held, other writers get busy, readers succeed and the snapshot includes writes still in the WAL", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("UPDATE task SET title = 'Uncheckpointed' WHERE id = 't1'");
    const directory = backupDirectory(db);

    const backupPath = withMigrationLock(db, databasePath(db), {}, () =>
      withOtherConnection(db, (other) => {
        expect(() => other.exec("BEGIN IMMEDIATE")).toThrow(SqliteError);
        expect(() =>
          other.exec("INSERT INTO label (id, name, color) VALUES ('l9', 'x', 'red')"),
        ).toThrow("database is locked");
        expect(count(other, "task")).toBe(3);

        return dbBackup.create(databasePath(db), directory, { client: "test", version: "1.2.3" })
          .path;
      }),
    );

    expect(count(db, "label")).toBe(2);
    const backup = openDatabase(backupPath, { readonly: true });
    try {
      expect(backup.query("SELECT title FROM task WHERE id = 't1'").get()).toEqual({
        title: "Uncheckpointed",
      });
      expect(count(backup, "label")).toBe(2);
    } finally {
      backup.close();
    }
  });
});

test("unknown free space stops the upgrade before the backup", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const step = migration(2, rebuildTask, ["task"]);

    expect(() =>
      upgradeDatabase(db, options(db, { migrations: [step], readFreeSpace: () => null })),
    ).toThrow(`The free disk space at ${dirname(databasePath(db))} is unknown`);
    expect(backups(db)).toEqual([]);
    expect(step.calls.count).toBe(0);
    expect(snapshot(db)).toEqual(before);
    expectHealthy(db);
  });
});

test("too little space for the remaining work stops the upgrade after the backup, before any write", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const step = migration(2, rebuildTask, ["task"]);
    // Each check reads the database, backup and temporary directories once, then compares.
    const READS_PER_CHECK = 3;
    let reads = 0;
    const readFreeSpace = () => {
      reads++;
      return reads <= READS_PER_CHECK ? PLENTY_OF_SPACE : NO_SPACE;
    };

    expect(() => upgradeDatabase(db, options(db, { migrations: [step], readFreeSpace }))).toThrow(
      "Not enough free disk space",
    );
    expect(reads).toBe(2 * READS_PER_CHECK);
    expect(step.calls.count).toBe(0);
    expect(snapshot(db)).toEqual(before);
    expect(backups(db)).toHaveLength(1);
    expectBackupHolds(join(backupDirectory(db), backups(db)[0]!), before);
    expectHealthy(db);
  });
});

test("a failed backup prevents the migration and leaves no backup file", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const step = migration(2, rebuildTask, ["task"]);
    mkdirSync(backupDirectory(db));
    chmodSync(backupDirectory(db), READ_ONLY_DIRECTORY_MODE);

    try {
      expect(() => upgradeDatabase(db, options(db, { migrations: [step] }))).toThrow(SqliteError);
    } finally {
      chmodSync(backupDirectory(db), WRITABLE_DIRECTORY_MODE);
    }

    expect(step.calls.count).toBe(0);
    expect(backups(db)).toEqual([]);
    expect(snapshot(db)).toEqual(before);
    expectHealthy(db);

    expect(upgradeDatabase(db, options(db)).status).toBe("upgraded");
    expect(backups(db)).toHaveLength(1);
  });
});

/**
 * A full disk rolls back the whole transaction after a statement without a statement journal,
 *  such as a one-row INSERT ... VALUES.
 * @link https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction
 */
const FILLING_INSERT = `INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action, changes)
  VALUES ('big', 1, 'Test Human', 'human', 'task', 't1', 'create', randomblob(1000000))`;

type FailureCase = {
  stage: string;
  /** Makes the next upgrade fail; returns the migration it should run. */
  arrange: (db: Database, control: ExecControl) => Migration & { calls: { count: number } };
  /** Checks the thrown error. */
  expectError: (error: unknown) => void;
  /** Whether SQLite ended the transaction itself before the wrapper's ROLLBACK. */
  rolledBackBySqlite?: boolean;
};

const PLANNED_FAILURE = new Error("planned migration failure");
const COMMIT_FAILURE = new Error("planned COMMIT failure");
const observed: { inTransaction: boolean | null } = { inTransaction: null };

const FAILURE_CASES: Array<FailureCase> = [
  {
    stage: "a migration write that throws",
    arrange: () =>
      migration(2, (db) => {
        rebuildTask(db);
        throw PLANNED_FAILURE;
      }, ["task"]),
    expectError: (error) => expect(error).toBe(PLANNED_FAILURE),
  },
  {
    stage: "a full disk during a migration write",
    arrange: (db) => {
      observed.inTransaction = null;
      const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
      db.exec(`PRAGMA max_page_count = ${pageCount + 2}`);
      return migration(2, (db) => {
        db.exec("ALTER TABLE project ADD COLUMN extra BLOB");
        try {
          db.exec(FILLING_INSERT);
        } finally {
          observed.inTransaction = db.inTransaction;
        }
      });
    },
    expectError: (error) => expect((error as SqliteError).code).toBe("SQLITE_FULL"),
    rolledBackBySqlite: true,
  },
  {
    stage: "the foreign key check",
    arrange: () =>
      migration(2, (db) => {
        db.exec(`INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
          VALUES ('orphan', 'missing', 1, 'x', 1, 1)`);
      }),
    expectError: (error) =>
      expect((error as Error).message).toContain("foreign keys point to missing rows"),
  },
  {
    stage: "the row count check",
    arrange: () =>
      migration(2, (db) => {
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
      }, ["label"]),
    expectError: (error) =>
      expect((error as Error).message).toContain("left 1 rows in label, which had 2"),
  },
  {
    stage: "COMMIT",
    arrange: (_db, control) => {
      control.failures.set("COMMIT", COMMIT_FAILURE);
      return migration(2, rebuildTask, ["task"]);
    },
    expectError: (error) => expect(error).toBe(COMMIT_FAILURE),
  },
];

test.each(FAILURE_CASES)(
  "a failure at $stage keeps the original error and the backup, changes nothing, and the next run upgrades without replay",
  ({ arrange, expectError, rolledBackBySqlite }) => {
    withControlledExec((db, control) => {
      seedBaseline(db);
      const before = snapshot(db);
      const failing = arrange(db, control);

      const error = catchError(() => upgradeDatabase(db, options(db, { migrations: [failing] })));

      expectError(error);
      // The rollback ran or was rightly skipped, without a cleanup error of its own.
      expect((error as Suppressing).suppressed).toBeUndefined();
      if (rolledBackBySqlite === true) {
        expect(observed.inTransaction).toBe(false);
      }
      expect(failing.calls.count).toBe(1);
      expect(snapshot(db)).toEqual(before);
      expect(backups(db)).toHaveLength(1);
      const keptBackup = join(backupDirectory(db), backups(db)[0]!);
      expectBackupHolds(keptBackup, before);
      expectHealthy(db);

      db.exec(`PRAGMA max_page_count = ${DEFAULT_MAX_PAGE_COUNT}`);
      const result = upgradeDatabase(db, options(db));

      expect(result.status).toBe("upgraded");
      expect(failing.calls.count).toBe(1);
      expect(backups(db)).toHaveLength(2);
      expect(existsSync(keptBackup)).toBe(true);
      expect(readSchemaVersion(db)).toBe(2);
      for (const table of ["task", ...CHILD_TABLES]) {
        expect(snapshot(db).rows[table]).toEqual(before.rows[table]!);
      }
      expectHealthy(db);
    });
  },
);

test("the lock wait times out with the path and elapsed time, and this caller changes nothing", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const waits: Array<LockWait> = [];

    withOtherConnection(db, (other) => {
      other.exec("BEGIN IMMEDIATE");
      const began = performance.now();

      const thrown = catchError(() =>
        upgradeDatabase(
          db,
          options(db, { budgetMs: SHORT_BUDGET_MS, onWait: (wait) => waits.push(wait) }),
        ),
      );

      const elapsed = performance.now() - began;
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(
        `for another writer to finish with the database at ${databasePath(db)}`,
      );
      expect(message).toMatch(/^Waited 0\.\d seconds/);
      expect(message).toContain("applied no changes");
      expect(message).toContain("Retry once the other writer finishes");
      expect((thrown as Error).cause).toBeInstanceOf(SqliteError);
      expect(elapsed).toBeGreaterThanOrEqual(SHORT_BUDGET_MS);
      expect(elapsed).toBeLessThan(SHORT_BUDGET_MS + TIMING_SLACK_MS);
      expect(waits).toEqual([{ databasePath: databasePath(db), budgetMs: SHORT_BUDGET_MS }]);
      other.exec("ROLLBACK");
    });

    expect(readSchemaVersion(db)).toBe(1);
    expect(existsSync(backupDirectory(db))).toBe(false);
    expectHealthy(db);
  });
});

test("retries after busy results share one budget instead of each waiting it in full", () => {
  withControlledExec((db, control) => {
    seedBaseline(db);
    control.busyAttempts = Number.POSITIVE_INFINITY;
    control.executed = [];
    const executed = control.executed;
    const waits: Array<LockWait> = [];
    const began = performance.now();

    expect(() =>
      upgradeDatabase(
        db,
        options(db, { budgetMs: SHORT_BUDGET_MS, onWait: (wait) => waits.push(wait) }),
      ),
    ).toThrow("applied no changes");

    const elapsed = performance.now() - began;
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_BUDGET_MS);
    expect(elapsed).toBeLessThan(SHORT_BUDGET_MS + TIMING_SLACK_MS);
    expect(waits).toHaveLength(1);

    // Foreign keys go off before the first BEGIN IMMEDIATE, outside any transaction.
    expect(executed.indexOf("PRAGMA foreign_keys = OFF")).toBeLessThan(
      executed.indexOf("BEGIN IMMEDIATE"),
    );

    // Each attempt's busy timeout is the time left, so the timeouts shrink and never exceed the budget.
    const attemptTimeouts = executed
      .map((sql, index) => (executed[index + 1] === "BEGIN IMMEDIATE" ? sql : null))
      .filter((sql) => sql != null)
      .map((sql) => Number(sql.replace("PRAGMA busy_timeout = ", "")));
    expect(attemptTimeouts.length).toBeGreaterThan(2);
    expect(attemptTimeouts[0]).toBe(0);
    const waitingTimeouts = attemptTimeouts.slice(1);
    expect(waitingTimeouts[0]).toBeLessThanOrEqual(SHORT_BUDGET_MS);
    for (let index = 1; index < waitingTimeouts.length; index++) {
      expect(waitingTimeouts[index]).toBeLessThan(waitingTimeouts[index - 1]!);
    }

    expect(foreignKeys(db)).toBe(1);
    expect(busyTimeout(db)).toBe(CALLER_BUSY_TIMEOUT_MS);
    expect(db.inTransaction).toBe(false);
  });
});

test("waiting is reported once however many attempts it takes", () => {
  withControlledExec((db, control) => {
    seedBaseline(db);
    control.busyAttempts = 3;
    const waits: Array<LockWait> = [];

    const result = upgradeDatabase(db, options(db, { onWait: (wait) => waits.push(wait) }));

    expect(result.status).toBe("upgraded");
    expect(waits).toHaveLength(1);
    expect(backups(db)).toHaveLength(1);
    expect(busyTimeout(db)).toBe(CALLER_BUSY_TIMEOUT_MS);
  });
});

test("a busy error from the work under the lock is thrown, not retried", () => {
  withDatabase((db) => {
    seedBaseline(db);
    const busy = new SqliteError("database is locked", 5, null);
    const waits: Array<LockWait> = [];
    let calls = 0;

    expect(() =>
      withMigrationLock(db, databasePath(db), { onWait: (wait) => waits.push(wait) }, () => {
        calls++;
        throw busy;
      }),
    ).toThrow(busy);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expectLockReleased(db);
  });
});

/** A database file set up as withDatabase does, for tests that await other processes. */
async function withDatabaseAsync(check: (db: Database) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-upgrade-"));

  try {
    const db = openDatabase(join(directory, "zinn.sqlite"));

    try {
      db.exec(`PRAGMA busy_timeout = ${CALLER_BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      await check(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a caller that waited for another process's upgrade rechecks the version and makes no backup", async () => {
  // Another process holds the lock, finishes an upgrade to version 2, then commits.
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.TEST_DB_PATH);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA user_version = 2");
    console.log("locked");
    Bun.sleepSync(${OTHER_PROCESS_HOLD_MS});
    db.exec("COMMIT");
    db.close();
  `;

  await withDatabaseAsync(async (db) => {
    seedBaseline(db);

    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, TEST_DB_PATH: databasePath(db) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const firstOutput = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");

    const step = migration(2);
    const waits: Array<LockWait> = [];
    const result = upgradeDatabase(
      db,
      options(db, { migrations: [step], onWait: (wait) => waits.push(wait) }),
    );

    expect(await child.exited).toBe(0);
    expect(result).toEqual({
      status: "current",
      databasePath: databasePath(db),
      previousVersion: 2,
      finalVersion: 2,
      changed: false,
      backupPath: null,
    });
    expect(waits).toHaveLength(1);
    expect(step.calls.count).toBe(0);
    expect(existsSync(backupDirectory(db))).toBe(false);
    expect(foreignKeys(db)).toBe(1);
    expectLockReleased(db);
  });
});

test("processes upgrading at once make one upgrade and one backup, and the rest find it current", async () => {
  const module = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);
  const script = `
    import { openDatabase } from ${module("../sqlite/bun.ts")};
    import { rebuildTask } from ${module("./testing.ts")};
    import { upgradeDatabase } from ${module("./upgrade.ts")};
    const db = openDatabase(process.env.TEST_DB_PATH);
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const slowRebuild = {
      version: 2,
      name: "slow rebuild",
      rebuilds: ["task"],
      apply(db) {
        Bun.sleepSync(${CONCURRENT_MIGRATION_MS});
        rebuildTask(db);
      },
    };
    const result = upgradeDatabase(db, {
      backup: { directory: process.env.TEST_BACKUP_DIR, client: "test", version: "1.2.3" },
      migrations: [slowRebuild],
    });
    db.close();
    console.log(JSON.stringify(result));
  `;

  await withDatabaseAsync(async (db) => {
    seedBaseline(db);
    const before = snapshot(db);
    const env = {
      ...process.env,
      ZINN_DIR: dirname(databasePath(db)),
      TEST_DB_PATH: databasePath(db),
      TEST_BACKUP_DIR: backupDirectory(db),
    };

    const runs = Array.from({ length: CONCURRENT_UPGRADERS }, async () => {
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as UpgradeResult;
    });
    const results = await Promise.all(runs);

    const upgraded = results.filter((result) => result.status === "upgraded");
    const current = results.filter((result) => result.status === "current");
    expect(upgraded).toHaveLength(1);
    expect(current).toHaveLength(CONCURRENT_UPGRADERS - 1);
    for (const result of current) {
      expect(result).toMatchObject({ previousVersion: 2, finalVersion: 2, backupPath: null });
    }
    expect(backups(db)).toEqual([basename(upgraded[0]!.backupPath!)]);
    expectBackupHolds(upgraded[0]!.backupPath!, before);

    const after = snapshot(db);
    expect(after.version).toBe(2);
    for (const table of ["task", ...CHILD_TABLES]) {
      expect(after.rows[table]).toEqual(before.rows[table]!);
    }
    expectHealthy(db);
  });
});
