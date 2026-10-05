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

function readObjectCountAndVersion(databasePath: string) {
  const db = openDatabase(databasePath);
  let found;

  try {
    applyConnectionSettings(db);

    const objectCount = db
      .query<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_schema")
      .get()!.count;

    found = { objectCount, version: readSchemaVersion(db) };
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }

  db.close();
  return found;
}

/**
 * Reports what state the database at `databasePath` is in, without creating a file, a table or a row.
 * A file that is not there is "absent", and nothing opens it.
 */
export function classifyDatabase(
  databasePath: string,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): DatabaseClassification {
  const latest = latestVersion(migrations);

  if (!existsSync(databasePath)) {
    return { state: "absent", version: 0, latestVersion: latest };
  }

  const { objectCount, version } = readObjectCountAndVersion(databasePath);

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
