import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { existsSync } from "node:fs";

import { openDatabase } from "#sqlite";

import { applyConnectionSettings } from "../connection";
import { attachSuppressed } from "../sqlite/database";
import { latestVersion, MIGRATIONS } from "./registry";
import { readSchemaVersion } from "./runner";

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
): DatabaseClassification {
  if (!existsSync(databasePath)) {
    return { state: "absent", version: 0, latestVersion: latestVersion(migrations) };
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
