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

/** Thrown when fresh creation finds the database no longer empty, such as when another process created it first. */
export class SchemaNotEmptyError extends Error {
  override name = "SchemaNotEmptyError";
}

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
export function withForeignKeysOff<T>(db: Database, action: () => T): T {
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

  let result: T;
  try {
    result = action();
  } catch (error) {
    try {
      restore();
    } catch (restoreError) {
      attachSuppressed(error, restoreError);
    }

    throw error;
  }

  restore();
  return result;
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

/** Checks row links and parent tables before committing a migration or restore. */
export function assertForeignKeys(db: Database, operation = "schema upgrade") {
  const violations = db.query<{ table: string; parent: string }>("PRAGMA foreign_key_check").all();

  if (violations.length > 0) {
    const links = new Set(violations.map(({ table, parent }) => `${table} to ${parent}`));
    throw new Error(
      `The ${operation} would leave ${violations.length} rows whose foreign keys point to missing rows (${[...links].join(", ")})`,
    );
  }

  // Row checks cannot find a missing parent table when its child table is empty.
  const missingParents = db
    .query<{ child: string; parent: string }>(`
    SELECT DISTINCT child.name AS child, foreign_key.[table] AS parent
    FROM main.sqlite_schema AS child
    JOIN pragma_foreign_key_list(child.name, 'main') AS foreign_key
    WHERE child.type = 'table' AND NOT EXISTS (
      SELECT 1 FROM main.sqlite_schema AS parent
      WHERE parent.type = 'table' AND parent.name = foreign_key.[table] COLLATE NOCASE
    )
  `)
    .all();

  if (missingParents.length > 0) {
    const links = missingParents.map(({ child, parent }) => `${child} to ${parent}`);
    throw new Error(
      `The ${operation} would leave foreign keys pointing to missing tables (${links.join(", ")})`,
    );
  }
}

/** Foreign keys can only be switched off outside a transaction, and the upgrade needs them off. */
export function assertOutsideTransaction(db: Database) {
  if (db.inTransaction) {
    throw new Error(
      "The schema upgrade must start outside a transaction, since SQLite cannot switch foreign keys off inside one",
    );
  }
}

/** Refuses an unmarked database (version 0) and any DB that is newer than the migrations can reach. */
export function assertUpgradable(version: number, migrations: ReadonlyArray<Migration>) {
  const targetVersion = latestVersion(migrations);
  const isSupported = version >= BASELINE_VERSION && version <= targetVersion;

  if (!isSupported) {
    throw new Error(
      `Only schema versions ${BASELINE_VERSION} to ${targetVersion} can be upgraded, and this database has version ${version}`,
    );
  }
}

/**
 * Runs every migration after `startVersion`,
 *  handles the foreign key check and the version bump,
 *  and returns whether it changed anything.
 * The caller begins one with foreign keys off, then commits it,
 *  or rolls it back when this throws.
 */
export function applyPendingMigrations(
  db: Database,
  migrations: ReadonlyArray<Migration>,
  startVersion: number,
) {
  /**
   * Outside a transaction each step would commit on its own,
   *  and with foreign keys on, dropping a table to rebuild it empties its child tables.
   */
  const isReady = db.inTransaction && readForeignKeys(db) === 0;
  if (!isReady) {
    throw new Error("Migrations must run inside a transaction begun with foreign keys off");
  }

  const targetVersion = latestVersion(migrations);
  const pending = migrations.filter((migration) => migration.version > startVersion);
  const isCurrent = pending.length === 0 && readSchemaVersion(db) === targetVersion;

  if (isCurrent) {
    return false;
  }

  for (const migration of pending) {
    applyMigration(db, migration);
  }

  assertForeignKeys(db);
  // The version is an integer from the checked registry.
  db.exec(`PRAGMA user_version = ${targetVersion}`);
  return true;
}

/**
 * Runs, in one BEGIN IMMEDIATE transaction with foreign keys off
 * A failure rolls back whatever ran and is thrown as it was and nothing is retried.
 */
function runUpgrade(db: Database, migrations: ReadonlyArray<Migration>, start: () => number) {
  assertMigrationOrder(migrations);
  assertOutsideTransaction(db);

  withForeignKeysOff(db, () => {
    db.transaction(() => {
      applyPendingMigrations(db, migrations, start());
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
    assertUpgradable(version, migrations);
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
      throw new SchemaNotEmptyError(
        `A schema can only be created in an empty database, and this one has ${objectCount} schema objects and version ${version}`,
      );
    }

    createBaseline(db);
    return BASELINE_VERSION;
  });
}
