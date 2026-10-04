/**
 * Brings a database to the latest schema version: every pending migration and the
 *  `PRAGMA user_version` bump run in one transaction, so a failure leaves the database as it was.
 * The caller opens and configures the connection; the runner switches only foreign keys.
 */
import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { attachSuppressed } from "../sqlite/database";
import { BASELINE_VERSION, createBaseline } from "./baseline";
import { assertMigrationOrder, latestVersion, MIGRATIONS } from "./registry";

/** SQLite's default `user_version`, which no Zinn version writes, making it an **unmarked** DB. */
const UNMARKED_VERSION = 0;

export function readSchemaVersion(db: Database) {
  return db.query<{ user_version: number }>("PRAGMA user_version").get()!.user_version;
}

function readForeignKeys(db: Database) {
  return db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get()!.foreign_keys;
}

function countRows(db: Database, table: string) {
  return db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

/**
 * Runs action with foreign keys off, then sets them back as they were, after a failure too.
 * Turning them off inside a transaction does nothing, and with them on, dropping a table to
 *  rebuild it deletes its rows first, which cascades into every child table.
 * @link https://www.sqlite.org/pragma.html#pragma_foreign_keys
 * @link https://www.sqlite.org/lang_droptable.html
 */
function withForeignKeysOff(db: Database, action: () => void) {
  const previous = readForeignKeys(db);
  db.exec("PRAGMA foreign_keys = OFF");

  const restore = () => {
    db.exec(`PRAGMA foreign_keys = ${previous}`);

    // A transaction left open by a failed ROLLBACK would make the pragma do nothing.
    if (readForeignKeys(db) !== previous) {
      throw new Error(
        "Foreign keys could not be switched back after the schema upgrade, because the connection is still inside a transaction",
      );
    }
  };

  try {
    action();
  } catch (error) {
    try {
      restore();
    } catch (restoreError) {
      attachSuppressed(error, restoreError);
    }

    throw error;
  }

  restore();
}

function applyMigration(db: Database, migration: Migration) {
  const countsBefore = migration.rebuilds.map((table) => ({ table, count: countRows(db, table) }));

  migration.apply(db);

  for (const { table, count } of countsBefore) {
    const countAfter = countRows(db, table);

    if (countAfter !== count) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) left ${countAfter} rows in ${table}, which had ${count}`,
      );
    }
  }
}

/** With foreign keys off, nothing else stops a migration from leaving rows that point nowhere. */
function assertForeignKeys(db: Database) {
  const violations = db.query<{ table: string; parent: string }>("PRAGMA foreign_key_check").all();

  if (violations.length > 0) {
    const links = new Set(violations.map(({ table, parent }) => `${table} to ${parent}`));
    throw new Error(
      `The schema upgrade would leave ${violations.length} rows whose foreign keys point to missing rows (${[...links].join(", ")})`,
    );
  }
}

/**
 * Runs, in one BEGIN IMMEDIATE transaction with foreign keys off: start, which returns the
 *  version the database is at, then every migration after that version, the checks and the
 *  version bump. A failure rolls back whatever ran and is thrown as it was; nothing is retried.
 */
function runUpgrade(db: Database, migrations: ReadonlyArray<Migration>, start: () => number) {
  assertMigrationOrder(migrations);

  if (db.inTransaction) {
    throw new Error(
      "The schema upgrade must start outside a transaction, since SQLite cannot switch foreign keys off inside one",
    );
  }

  const targetVersion = latestVersion(migrations);

  withForeignKeysOff(db, () => {
    db.transaction(() => {
      const startVersion = start();
      const pending = migrations.filter((migration) => migration.version > startVersion);
      const isCurrent = pending.length === 0 && readSchemaVersion(db) === targetVersion;

      if (isCurrent) {
        return;
      }

      for (const migration of pending) {
        applyMigration(db, migration);
      }

      assertForeignKeys(db);
      // PRAGMA takes no bound parameters; the version is an integer from the checked registry.
      db.exec(`PRAGMA user_version = ${targetVersion}`);
    }).immediate();
  });
}

/**
 * Upgrades a database marked with a supported schema version to the latest one.
 * A database already at the latest version is left unchanged.
 * Refuses an unmarked database (version 0) and one newer than this build.
 */
export function upgradeSchema(db: Database, migrations: ReadonlyArray<Migration> = MIGRATIONS) {
  runUpgrade(db, migrations, () => {
    const version = readSchemaVersion(db);
    const targetVersion = latestVersion(migrations);
    const isSupported = version >= BASELINE_VERSION && version <= targetVersion;

    if (!isSupported) {
      throw new Error(
        `Only schema versions ${BASELINE_VERSION} to ${targetVersion} can be upgraded, and this database has version ${version}`,
      );
    }

    return version;
  });
}

/** Creates the baseline and runs every migration on an empty database, ending at the latest version. */
export function createSchema(db: Database, migrations: ReadonlyArray<Migration> = MIGRATIONS) {
  runUpgrade(db, migrations, () => {
    const objectCount = db
      .query<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_schema")
      .get()!.count;
    const version = readSchemaVersion(db);
    const isEmpty = objectCount === 0 && version === UNMARKED_VERSION;

    if (!isEmpty) {
      throw new Error(
        `A schema can only be created in an empty database, and this one has ${objectCount} schema objects and version ${version}`,
      );
    }

    createBaseline(db);
    return BASELINE_VERSION;
  });
}
