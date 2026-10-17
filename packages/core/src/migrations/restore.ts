/**
 * Copies the backup's contents into the database,
 *  inside one write transaction on a connection that holds SQLite's write lock.
 * The database file and its -wal and -shm files stay where they are, so moving or replacing them
 *  while another process has the file open would lose that process's writes.
 * @link https://www.sqlite.org/howtocorrupt.html
 */
import type { BackupCreateInput } from "../db/backup.js";
import type { Database } from "../sqlite/database.js";
import type { Migration } from "./registry.js";
import type { FreeSpace } from "./space.js";
import type { LockOptions } from "./upgrade.js";

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { openDatabase } from "#sqlite";

import * as dbBackup from "../db/backup.js";
import { applyConnectionSettings } from "../connection.js";
import { attachSuppressed, SqliteError } from "../sqlite/database.js";
import { BASELINE_VERSION } from "./baseline.js";
import { classifyConnection } from "./classify.js";
import { latestVersion, MIGRATIONS } from "./registry.js";
import {
  assertForeignKeys,
  createSchema,
  readSchemaVersion,
  withForeignKeysOff,
} from "./runner.js";
import {
  assertFreeSpace,
  estimateRequiredFree,
  measureFiles,
  readFreeSpace,
  requireDatabaseFile,
  spacePathsFor,
} from "./space.js";
import { withMigrationLock } from "./upgrade.js";
import { CoreError, isMissingFileError } from "../errors.js";

/** The name the backup is attached under while it is copied. */
const SOURCE_SCHEMA = "restore_source";
/** SQLite reserves names with this prefix for its own tables. @link https://www.sqlite.org/fileformat2.html#internal_schema_objects */
const INTERNAL_PREFIX = "sqlite_";
/** SQLite's table of AUTOINCREMENT counters. @link https://www.sqlite.org/autoinc.html */
const SEQUENCE_TABLE = "sqlite_sequence";
/** The one row `PRAGMA integrity_check` returns for a sound database. */
const INTEGRITY_OK = "ok";

/** Thrown when a backup cannot be restored, before anything in the database changed. */
export class RestoreRefusedError extends CoreError {
  override name = "RestoreRefusedError";
}

/** A backup file that passed `checkBackup`, and its schema version. */
export type CheckedBackup = { path: string; version: number };

export type RestoreOptions = LockOptions & {
  /** Where the backup of the replaced database goes, and the client named in its file name and in errors. */
  backup: BackupCreateInput & { directory: string };
  migrations?: ReadonlyArray<Migration>;
  /** Reads a filesystem's free space. Tests pass their own, so no test fills the disk. */
  readFreeSpace?: (path: string) => FreeSpace | null;
};

export type RestoreResult = {
  databasePath: string;
  /** The database's schema version before the restore, 0 when it had none. */
  previousVersion: number;
  /** The backup's schema version, which the database has now. */
  restoredVersion: number;
  /** The backup of the database the restore replaced, null when the database was empty. */
  backupPath: string | null;
};

type TableRow = { name: string; type: string; wr: number };

/** Backticks quote a name, with any backtick inside it doubled. @link https://www.sqlite.org/lang_keywords.html */
function quote(name: string) {
  return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * The tables that hold a database's rows: ordinary and virtual ones.
 * Leaves out SQLite's own tables and the shadow tables a virtual table such as the search index keeps,
 *  which SQLite creates, fills and drops along with it.
 * @link https://www.sqlite.org/pragma.html#pragma_table_list
 */
function listTables(db: Database, schema: string) {
  return db
    .query<TableRow>("SELECT name, type, wr FROM pragma_table_list WHERE schema = $schema")
    .all({ $schema: schema })
    .filter(
      ({ name, type }) =>
        (type === "table" || type === "virtual") && !name.startsWith(INTERNAL_PREFIX),
    );
}

/** The columns an INSERT can name, without hidden and generated ones. */
function readColumns(db: Database, schema: string, table: string) {
  return db
    .query<{ name: string }>("SELECT name FROM pragma_table_info($table, $schema) ORDER BY cid")
    .all({ $table: table, $schema: schema })
    .map(({ name }) => name);
}

/**
 * Each table with its column names, both in name order, to tell whether two databases have the same tables.
 * Column order is left out: a column added by ALTER TABLE comes last, and the copy names every column.
 */
function readTableShapes(db: Database, schema: string) {
  return listTables(db, schema)
    .map(({ name }) => `${name}(${readColumns(db, schema, name).sort().join(", ")})`)
    .sort();
}

/** The tables this build creates for a database at version. */
function expectedTableShapes(version: number, migrations: ReadonlyArray<Migration>) {
  const db = openDatabase(":memory:");

  try {
    createSchema(db, migrations.slice(0, version - BASELINE_VERSION));
    return readTableShapes(db, "main");
  } finally {
    db.close();
  }
}

function countRows(db: Database, schema: string, table: string) {
  return db
    .query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${schema}.${quote(table)}`)
    .get()!.count;
}

function hasSequenceTable(db: Database, schema: string) {
  return (
    db
      .query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${schema}.sqlite_schema WHERE name = $name`,
      )
      .get({ $name: SEQUENCE_TABLE })!.count > 0
  );
}

function newerBackupError(
  path: string,
  version: number,
  latest: number,
  { client, version: buildVersion }: BackupCreateInput,
) {
  const maker = dbBackup.readBackupFileName(path);
  const advice =
    maker == null
      ? "Restore it with a newer Zinn version"
      : `It was made by ${maker.client} ${maker.version}; restore it with that version or a newer one`;

  return new RestoreRefusedError(
    `The backup at ${path} has schema version ${version}, but this build (${client} ${buildVersion}) reaches only version ${latest}, so nothing was restored. ${advice}`,
    "conflict",
    {
      entity: "backup",
      backupPath: path,
      schemaVersion: version,
      supportedSchemaVersion: latest,
      reason: "newer_database",
    },
  );
}

/** SQLite reports a file that is not a database, or is damaged before any page can be read, with these codes. */
function isUnreadable(error: unknown) {
  return (
    error instanceof SqliteError &&
    (error.code.startsWith("SQLITE_NOTADB") || error.code.startsWith("SQLITE_CORRUPT"))
  );
}

function readCheckedVersion(
  source: Database,
  path: string,
  migrations: ReadonlyArray<Migration>,
  build: BackupCreateInput,
) {
  const problems = source
    .query<{ integrity_check: string }>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check);
  const isSound = problems.length === 1 && problems[0] === INTEGRITY_OK;
  if (!isSound) {
    throw new RestoreRefusedError(
      `The backup at ${path} failed SQLite's integrity check (${problems[0]}), so nothing was restored`,
      "storage",
      { entity: "backup", backupPath: path, reason: "corrupt" },
    );
  }

  const version = readSchemaVersion(source);
  const latest = latestVersion(migrations);

  if (version < BASELINE_VERSION) {
    throw new RestoreRefusedError(
      `The file at ${path} has no schema version, so nothing was restored. Only backups with schema versions ${BASELINE_VERSION} to ${latest} can be restored`,
      "conflict",
      {
        entity: "backup",
        backupPath: path,
        schemaVersion: version,
        supportedSchemaVersion: latest,
        reason: "invalid_backup",
      },
    );
  }

  if (version > latest) {
    throw newerBackupError(path, version, latest, build);
  }

  const expected = expectedTableShapes(version, migrations);
  const actual = readTableShapes(source, "main");
  const isZinnDatabase =
    actual.length === expected.length && actual.every((shape, index) => shape === expected[index]);

  if (!isZinnDatabase) {
    throw new RestoreRefusedError(
      `The file at ${path} is not a Zinn database: its tables differ from the ones Zinn creates at its schema version (${version}), so nothing was restored`,
      "conflict",
      {
        entity: "backup",
        backupPath: path,
        schemaVersion: version,
        supportedSchemaVersion: latest,
        reason: "invalid_backup",
      },
    );
  }

  return version;
}

/**
 * Checks, through a read-only connection of its own, that the file at path is a sound Zinn database
 *  with a schema version from the baseline to the latest this build reaches.
 * Read-only, so a journal left next to the file is never rolled back into it.
 */
export function checkBackup(
  path: string,
  migrations: ReadonlyArray<Migration>,
  build: BackupCreateInput,
): CheckedBackup {
  try {
    statSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    throw new RestoreRefusedError(`There is no file at ${path} to restore`, "missing", {
      entity: "backup",
      backupPath: path,
    });
  }

  const source = openDatabase(path, { readonly: true });
  let version: number;

  try {
    applyConnectionSettings(source);
    version = readCheckedVersion(source, path, migrations, build);
  } catch (error) {
    try {
      source.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    if (isUnreadable(error)) {
      throw new RestoreRefusedError(
        `The file at ${path} is damaged or is not a SQLite database (${(error as Error).message}), so nothing was restored`,
        "storage",
        {
          entity: "backup",
          backupPath: path,
          reason: (error as SqliteError).code.startsWith("SQLITE_NOTADB")
            ? "not_database"
            : "corrupt",
        },
        { cause: error },
      );
    }

    throw error;
  }

  source.close();
  return { path, version };
}

/** Drops every trigger, view and table in main. Indexes and shadow tables go with their tables. */
function dropDatabaseTables(db: Database) {
  const triggers = db
    .query<{ name: string }>("SELECT name FROM main.sqlite_schema WHERE type = 'trigger'")
    .all();

  const views = db
    .query<{ name: string }>(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'view'",
    )
    .all();

  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER main.${quote(name)}`);
  }

  for (const { name } of views) {
    db.exec(`DROP VIEW main.${quote(name)}`);
  }

  for (const { name } of listTables(db, "main")) {
    db.exec(`DROP TABLE main.${quote(name)}`);
  }
}

/**
 * Runs the backup's own CREATE statements in main: tables first, then indexes, then triggers and views.
 * An unqualified CREATE makes its object in main, and indexes and triggers find their table there first.
 * @link https://www.sqlite.org/lang_naming.html
 */
function createDatabaseTables(db: Database) {
  const skipped = new Set(
    db
      .query<{ name: string }>(
        "SELECT name FROM pragma_table_list WHERE schema = $schema AND type = 'shadow'",
      )
      .all({ $schema: SOURCE_SCHEMA })
      .map(({ name }) => name),
  );
  const objects = db
    .query<{ name: string; sql: string }>(
      `SELECT name, sql FROM ${SOURCE_SCHEMA}.sqlite_schema WHERE sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`,
    )
    .all()
    .filter(({ name }) => !name.startsWith(INTERNAL_PREFIX) && !skipped.has(name));

  for (const { sql } of objects) {
    db.exec(sql);
  }
}

/**
 * Copies every table's rows with their rowids, then the AUTOINCREMENT counters, and returns the tables.
 * The search index is copied through its virtual table, which rebuilds the index from the backup's
 *  stored text. SQLite refuses writes to the shadow tables behind it.
 * @link https://www.sqlite.org/fts5.html
 */
function copyRows(db: Database) {
  const tables = listTables(db, SOURCE_SCHEMA);

  for (const { name, wr } of tables) {
    const columns = readColumns(db, SOURCE_SCHEMA, name).map(quote);
    // A WITHOUT ROWID table has no rowid to copy.
    const list = (wr === 1 ? columns : ["rowid", ...columns]).join(", ");
    db.exec(
      `INSERT INTO main.${quote(name)} (${list}) SELECT ${list} FROM ${SOURCE_SCHEMA}.${quote(name)}`,
    );
  }

  // Dropping its tables does not drop sqlite_sequence, so it may hold the replaced database's counters.
  if (hasSequenceTable(db, "main")) {
    db.exec(`DELETE FROM main.${SEQUENCE_TABLE}`);
  }

  if (hasSequenceTable(db, SOURCE_SCHEMA)) {
    db.exec(
      `INSERT INTO main.${SEQUENCE_TABLE} (name, seq) SELECT name, seq FROM ${SOURCE_SCHEMA}.${SEQUENCE_TABLE}`,
    );
  }

  return tables;
}

function assertRowCounts(db: Database, tables: ReadonlyArray<TableRow>) {
  for (const { name } of tables) {
    const copied = countRows(db, "main", name);
    const expected = countRows(db, SOURCE_SCHEMA, name);

    if (copied !== expected) {
      throw new Error(
        `The restore copied ${copied} rows into ${name}, and the backup has ${expected}`,
      );
    }
  }
}

/** Replaces main's schema, rows and version with the attached backup's, inside the caller's transaction. */
function replaceDatabaseContents(db: Database, version: number) {
  dropDatabaseTables(db);
  createDatabaseTables(db);

  const tables = copyRows(db);
  // The version is an integer read by checkBackup.
  db.exec(`PRAGMA main.user_version = ${version}`);
  assertForeignKeys(db, "restore");
  assertRowCounts(db, tables);
}

/**
 * The free bytes the restore needs: the backup of the current database, then the backup's pages
 *  written into the database and its -wal file, with the estimate's usual headroom.
 * The copy is treated like one rebuilt table as large as the whole backup.
 */
function requiredFree(db: Database, sourceBytes: number, includeBackup: boolean) {
  return estimateRequiredFree(
    {
      ...measureFiles(db),
      rebuildsTables: true,
      rebuiltTableBytes: sourceBytes,
      regeneratesSearch: false,
      searchIndexBytes: 0,
      searchSourceBytes: 0,
      taskCount: 0,
    },
    { includeBackup },
  );
}

function readSourceBytes(db: Database) {
  const read = (pragma: string) =>
    db.query<Record<string, number>>(`PRAGMA ${SOURCE_SCHEMA}.${pragma}`).get()![pragma]!;

  return read("page_size") * read("page_count");
}

function detachSource(db: Database) {
  db.exec(`DETACH DATABASE ${SOURCE_SCHEMA}`);
}

/**
 * Restores a checked backup into the database behind db, whatever that database's version.
 * The backup is attached by path before the write lock. Only main is written;
 *  SQLite may checkpoint a WAL-mode source without changing its rows.
 * Under the lock, with foreign keys off, a database that is not empty gets a free-space check and
 *  a backup through a separate connection while db has written nothing.
 * Then, in the same transaction, it drops main's tables, views and triggers, creates the backup's,
 *  copies the rows and sets the backup's version, and requires no broken foreign keys and every table's
 *  row count to match before committing.
 * Any failure rolls back and is thrown as it was, a finished backup is kept, and nothing is retried.
 * @link https://www.sqlite.org/lang_attach.html
 */
export function restoreBackup(
  db: Database,
  checked: CheckedBackup,
  {
    backup,
    readFreeSpace: readFree = readFreeSpace,
    migrations = MIGRATIONS,
    ...lock
  }: RestoreOptions,
): RestoreResult {
  const databasePath = requireDatabaseFile(db, "restore");
  const spacePaths = spacePathsFor(databasePath, backup.directory);
  db.query(`ATTACH DATABASE $path AS ${SOURCE_SCHEMA}`).run({ $path: resolve(checked.path) });

  let result: RestoreResult;

  try {
    result = withForeignKeysOff(db, () =>
      withMigrationLock(db, databasePath, { ...lock, operation: "restore" }, () => {
        const { state, version: previousVersion } = classifyConnection(db, migrations);
        const sourceBytes = readSourceBytes(db);
        const savesDatabase = state !== "empty";

        // The free space of a missing directory is unknown, which would stop the restore.
        mkdirSync(backup.directory, { recursive: true });
        assertFreeSpace(spacePaths, requiredFree(db, sourceBytes, savesDatabase), readFree);

        let backupPath: string | null = null;

        if (savesDatabase) {
          // db holds the write lock and has written nothing, so the backup is the database as it is.
          backupPath = dbBackup.create(databasePath, backup.directory, backup).path;
          assertFreeSpace(spacePaths, requiredFree(db, sourceBytes, false), readFree);
        }

        replaceDatabaseContents(db, checked.version);

        return { databasePath, previousVersion, restoredVersion: checked.version, backupPath };
      }),
    );
  } catch (error) {
    try {
      detachSource(db);
    } catch (detachError) {
      attachSuppressed(error, detachError);
    }

    throw error;
  }

  detachSource(db);
  return result;
}

/**
 * Restores the backup at backupPath into the database at databasePath, creating the database when
 *  there is none. The backup is checked before the database is opened, so a refused backup creates nothing.
 * The database opens through a connection that creates no tables and ignores the open policy,
 *  so a database this build cannot write, or one without a schema version, can be restored too.
 */
export function restoreDatabase(
  databasePath: string,
  backupPath: string,
  options: RestoreOptions,
): RestoreResult {
  const checked = checkBackup(backupPath, options.migrations ?? MIGRATIONS, options.backup);

  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);

  try {
    applyConnectionSettings(db);
    const result = restoreBackup(db, checked, options);
    db.close();
    return result;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }
}
