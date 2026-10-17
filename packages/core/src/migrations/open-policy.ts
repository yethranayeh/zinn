/**
 * Decides how core opens a database, from its state, the build and the client's policy.
 * A database core cannot change safely opens read-only, or not at all, before anything writes to it.
 */
import type { Storage } from "../constant.js";
import type { ReleaseMode } from "../release.js";
import type { DatabaseState } from "./classify.js";
import type { LockWait } from "./upgrade.js";

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { CoreError, isMissingFileError } from "../errors.js";

/** What a client tells core about itself before core opens the database. */
export type OpenPolicy = {
  /**
   * The client (anything that consumes core), named in diagnostics and in the file name of
   *  the backup an automatic upgrade takes.
   * @example {client: "cli", version: "0.37.0"}
   */
  client: string;
  version: string;
  /** What the client runs from, named in diagnostics, such as the CLI's script path. */
  executable: string;
  /** The client's own release mode, independent of core's identity. */
  release: ReleaseMode;
  /** Opens a database without a schema version for best-effort reading. It never allows changes. */
  allowsLegacyRead: boolean;
  /** Called once when an automatic upgrade starts waiting for another writer. */
  onWait?: (wait: LockWait) => void;
  /** Called once, when a database without a schema version is opened. */
  onLegacyRead?: (facts: DatabaseFacts) => void;
};

/** Used until a client calls configureDatabase, as in tests and scripts. */
export const DEFAULT_OPEN_POLICY: OpenPolicy = {
  client: "unknown",
  version: "unknown",
  executable: "unknown",
  release: "source",
  allowsLegacyRead: false,
};

/**
 * Why a database opened read-only:
 * - older: a build that is not a published release found a protected database at an older version
 * - newer: the database has a newer version than this build reaches
 * - unmarked: the database has no schema version, and the client allowed best-effort reading
 */
export type ReadOnlyReason = "older" | "newer" | "unmarked";

export type OpenDecision =
  | { action: "create" }
  | { action: "write" }
  | { action: "upgrade" }
  | { action: "read-only"; reason: ReadOnlyReason }
  | { action: "refuse" };

export type OpenFacts = {
  state: DatabaseState;
  /** Whether a source checkout leaves the database's upgrade to an explicit migration. Asked only for an older database. */
  isProtectedDatabase: () => boolean;
  coreRelease: ReleaseMode;
  clientRelease: ReleaseMode;
  allowsLegacyRead: boolean;
};

export function decideOpen(facts: OpenFacts): OpenDecision {
  switch (facts.state) {
    case "absent":
    case "empty":
      return { action: "create" };
    case "current":
      return { action: "write" };
    case "newer":
      return { action: "read-only", reason: "newer" };
    case "unmarked":
      return facts.allowsLegacyRead
        ? { action: "read-only", reason: "unmarked" }
        : { action: "refuse" };
    case "older": {
      /**
       * Source code may hold unreleased migrations,
       *  so it upgrades a protected database only through an explicit migration.
       */
      const isPublishedBuild =
        facts.coreRelease === "published" && facts.clientRelease === "published";
      const upgradesAutomatically = isPublishedBuild || !facts.isProtectedDatabase();

      return upgradesAutomatically
        ? { action: "upgrade" }
        : { action: "read-only", reason: "older" };
    }
  }
}

/**
 * Whether `mainDir` holds the default database, also when `ZINN_DIR` reaches it through another path or a link.
 * Any failure other than a missing folder counts as the default database, which only restricts.
 */
export function isDefaultDatabase(mainDir: string, defaultMainDir: string) {
  try {
    return realpathSync(mainDir) === realpathSync(defaultMainDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return resolve(mainDir) === resolve(defaultMainDir);
    }

    return true;
  }
}

/**
 * Whether a source checkout opens the store's older database read-only, leaving the upgrade to an explicit migration.
 * Every store is protected, whether the default folder or chosen by a settings file, except a `ZINN_DIR` store
 *  that does not reach the default folder.
 */
export function isProtectedStorage({ source, directory, defaultDirectory }: Storage) {
  if (source !== "env") {
    return true;
  }

  return isDefaultDatabase(directory, defaultDirectory);
}

export type DatabaseFacts = {
  databasePath: string;
  version: number;
  latestVersion: number;
};

/** Thrown before any SQL runs when a change is asked of a database that opened read-only. */
export class ReadOnlyDatabaseError extends CoreError {
  override name = "ReadOnlyDatabaseError";
  readonly reason: ReadOnlyReason;

  constructor(reason: ReadOnlyReason, facts: DatabaseFacts, policy: OpenPolicy) {
    super(describeReadOnly(reason, facts, policy), "conflict", {
      entity: "database",
      databasePath: facts.databasePath,
      schemaVersion: facts.version,
      supportedSchemaVersion: facts.latestVersion,
      reason:
        reason === "older"
          ? "older_database"
          : reason === "newer"
            ? "newer_database"
            : "unmarked_database",
    });
    this.reason = reason;
  }
}

/** Thrown when the database has no schema version and the client did not allow legacy reads. */
export class UnmarkedDatabaseError extends CoreError {
  override name = "UnmarkedDatabaseError";

  constructor({ databasePath, version, latestVersion }: DatabaseFacts) {
    super(
      `The database at ${databasePath} has no schema version, so it was not opened and was left unchanged. Zinn changes it only after its schema is verified and adopted as version 1, and reads it only when the client allows best-effort legacy reads`,
      "conflict",
      {
        entity: "database",
        databasePath,
        schemaVersion: version,
        supportedSchemaVersion: latestVersion,
        reason: "unmarked_database",
      },
    );
  }
}

function describeReadOnly(
  reason: ReadOnlyReason,
  { databasePath, version, latestVersion }: DatabaseFacts,
  { client, version: clientVersion, executable }: OpenPolicy,
) {
  const build = `${client} ${clientVersion}, run from ${executable}`;
  const opening = `The database at ${databasePath} is read-only, and this change was not made`;

  switch (reason) {
    case "older":
      return `${opening}: it has schema version ${version}, and this build (${build}) uses version ${latestVersion}. A build that is not a published release upgrades only a ZINN_DIR database by itself`;
    case "newer":
      return `${opening}: it has schema version ${version}, but this build (${build}) reaches only version ${latestVersion}. Use a newer Zinn version to change it`;
    case "unmarked":
      return `${opening}: it has no schema version, so it is open for reading only`;
  }
}
