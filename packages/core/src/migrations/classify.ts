import type { Database } from "../sqlite/database.js";
import type { Migration } from "./registry.js";

import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { openDatabase } from "#sqlite";

import { applyConnectionSettings } from "../connection.js";
import { attachSuppressed } from "../sqlite/database.js";
import { latestVersion, MIGRATIONS } from "./registry.js";
import { readSchemaVersion } from "./runner.js";

/**
 * - absent: no database file
 * - empty: a file with no tables and no schema version
 * - unmarked: tables but no schema version, which no Zinn version before schema versions had
 * - current, older, newer: the schema version compared with the latest one this build reaches
 */
export type DatabaseState = "absent" | "empty" | "unmarked" | "current" | "older" | "newer";

export type DatabaseClassification = {
  state: DatabaseState;
  /** The database's schema version, 0 when it has none or does not exist. */
  version: number;
  /** The latest schema version this build reaches. */
  latestVersion: number;
};

/**
 * Reports the state of the database behind an open connection, without writing to it.
 * A connection always has a file or memory behind it, so the state is never "absent".
 */
export function classifyConnection(
  db: Database,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): DatabaseClassification {
  const latest = latestVersion(migrations);
  const objectCount = db
    .query<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_schema")
    .get()!.count;
  const version = readSchemaVersion(db);

  const state = ((): DatabaseState => {
    if (version === 0) {
      return objectCount === 0 ? "empty" : "unmarked";
    }

    if (version === latest) {
      return "current";
    }

    return version > latest ? "newer" : "older";
  })();

  return { state, version, latestVersion: latest };
}

/**
 * Reports what state the database at `databasePath` is in, without creating a file, a table or a row.
 * A file that is not there is "absent", and nothing opens it.
 */
export function classifyDatabase(
  databasePath: string,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  options: { queryOnly?: boolean } = {},
): DatabaseClassification {
  try {
    statSync(databasePath);
  } catch (error) {
    const isMissing =
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR");

    if (!isMissing) {
      throw error;
    }
    return { state: "absent", version: 0, latestVersion: latestVersion(migrations) };
  }

  if (options.queryOnly) {
    return withDatabaseInspection(databasePath, (db) => classifyConnection(db, migrations));
  }

  const db = openDatabase(databasePath);
  let classification;

  try {
    applyConnectionSettings(db);
    classification = classifyConnection(db, migrations);
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }

  db.close();
  return classification;
}

/** Inspects an existing database without application writes or schema initialization. */
export function withDatabaseInspection<T>(databasePath: string, inspect: (db: Database) => T): T {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "rw");
  const db = openDatabase(url.href);
  let result: T;

  try {
    db.exec("PRAGMA query_only = ON");
    applyConnectionSettings(db);
    db.exec("BEGIN");
    result = inspect(db);
    db.exec("ROLLBACK");
  } catch (error) {
    if (db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        attachSuppressed(error, rollbackError);
      }
    }

    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }

  db.close();
  return result;
}
