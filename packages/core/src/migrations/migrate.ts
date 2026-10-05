import type { BackupCreateInput } from "../db/backup";
import type { UpgradeOptions } from "./upgrade";

import { openDatabase } from "#sqlite";

import { applyConnectionSettings } from "../connection";
import { attachSuppressed } from "../sqlite/database";
import { classifyDatabase } from "./classify";
import { upgradeDatabase } from "./upgrade";

/** Thrown when the database is in a state that `migrate` leaves alone, so nothing was attempted. */
export class MigrationRefusedError extends Error {
  override name = "MigrationRefusedError";
}

export type MigrateResult = {
  databasePath: string;
  previousVersion: number;
  finalVersion: number;
  changed: boolean;
  /** The snapshot taken before upgrading, null when nothing changed. */
  backupPath: string | null;
};

export type MigrateOptions = Omit<UpgradeOptions, "backup"> & {
  /** Where snapshots go, and the client and version that name the running code. */
  backup: UpgradeOptions["backup"] & BackupCreateInput;
};

function newerDatabaseError(
  databasePath: string,
  version: number,
  latestVersion: number,
  { client, version: buildVersion }: BackupCreateInput,
) {
  return new MigrationRefusedError(
    `The database at ${databasePath} has schema version ${version}, but this build (${client} ${buildVersion}) reaches only version ${latestVersion}. It was left unchanged. Use a newer Zinn version`,
  );
}

/**
 * The explicit, deliberate upgrade of an older database to the latest schema version.
 * Refuses a database that is absent, empty, unmarked or newer than this build, and leaves it as it is.
 * A DB detected as *current* is left alone without a lock or backup.
 */
export function migrateDatabase(
  databasePath: string,
  { backup, migrations, ...upgrade }: MigrateOptions,
): MigrateResult {
  const { state, version, latestVersion } = classifyDatabase(databasePath, migrations);

  switch (state) {
    case "absent":
    case "empty":
      throw new MigrationRefusedError(
        `There is no Zinn database with data at ${databasePath} to upgrade. A new database is created with the latest schema the first time Zinn writes to it`,
      );
    case "unmarked":
      throw new MigrationRefusedError(
        `The database at ${databasePath} has no schema version, so it cannot be upgraded until its schema is verified and adopted as version 1`,
      );
    case "newer":
      throw newerDatabaseError(databasePath, version, latestVersion, backup);
    case "current":
      return {
        databasePath,
        previousVersion: version,
        finalVersion: version,
        changed: false,
        backupPath: null,
      };
    case "older":
      break;
  }

  const db = openDatabase(databasePath);

  try {
    applyConnectionSettings(db);
    db.exec("PRAGMA foreign_keys = ON");

    const result = upgradeDatabase(db, { ...upgrade, backup, migrations });

    // Another caller may have upgraded the database to a newer build's version while this waited.
    if (result.status === "newer") {
      throw newerDatabaseError(databasePath, result.previousVersion, latestVersion, backup);
    }

    const { status: _status, ...migrated } = result;
    db.close();
    return migrated;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      attachSuppressed(error, closeError);
    }

    throw error;
  }
}
