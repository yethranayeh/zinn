import type { Database } from "../sqlite/database.js";

import { BASELINE_VERSION } from "./baseline.js";
import { actorIdentityMigration } from "./actor-identity.js";

export type Migration = {
  /** The schema version this migration brings the database to. */
  version: number;
  /** A short description that names the migration in errors. */
  name: string;
  /**
   * Tables this migration rebuilds (create a new table, copy the rows, drop, rename).
   * The runner requires each to hold as many rows afterwards as before.
   */
  rebuilds: ReadonlyArray<string>;
  /** Whether `apply` calls `regenerateSearch`. */
  regeneratesSearch?: boolean;
  /**
   * Runs inside the runner's transaction, with foreign keys off.
   * It uses only the connection it is given: the `db/*` helpers open their own through `getDb()`
   */
  apply(db: Database): void;
};

/**
 * Every schema change after the baseline, oldest first.
 * Databases that already ran it would keep its old result,
 *  while newer ones got the new one.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [actorIdentityMigration];

/** Each migration's version follows the one before it, starting right after the baseline. */
export function assertMigrationOrder(migrations: ReadonlyArray<Migration>) {
  migrations.forEach((migration, index) => {
    const expectedVersion = BASELINE_VERSION + 1 + index;

    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) is out of order: version ${expectedVersion} was expected, since versions follow the baseline (${BASELINE_VERSION}) one by one`,
      );
    }
  });
}

/** The schema version a database has after every migration in the list. */
export function latestVersion(migrations: ReadonlyArray<Migration>) {
  return BASELINE_VERSION + migrations.length;
}

assertMigrationOrder(MIGRATIONS);
