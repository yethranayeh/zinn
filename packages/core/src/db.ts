import type { Storage } from "./storage.js";
import type { Database } from "./sqlite/database.js";
import type { DatabaseClassification } from "./migrations/classify.js";
import type {
  DatabaseFacts,
  OpenDecision,
  OpenPolicy,
  ReadOnlyReason,
} from "./migrations/open-policy.js";

import { existsSync } from "node:fs";
import { openResolvedDatabase } from "#sqlite";

import { getBackupStorage, getStorage, resetStorageForTests } from "./storage.js";
import { ensureDataDirectory } from "./config.js";
import { applyConnectionSettings } from "./connection.js";
import { classifyConnection } from "./migrations/classify.js";
import {
  decideOpen,
  DEFAULT_OPEN_POLICY,
  isProtectedStorage,
  MissingDatabaseError,
  ReadOnlyDatabaseError,
  UnmarkedDatabaseError,
} from "./migrations/open-policy.js";
import { MIGRATIONS } from "./migrations/registry.js";
import { createSchema, SchemaNotEmptyError } from "./migrations/runner.js";
import { upgradeDatabase } from "./migrations/upgrade.js";
import { readCoreReleaseMode } from "./release.js";
import { attachSuppressed, isSqliteErrorCode } from "./sqlite/database.js";
import { rethrowSearchError } from "./search-error.js";
import { withChangeHooks } from "./hooks.js";

let db: Database | null = null;
let policy: OpenPolicy = DEFAULT_OPEN_POLICY;
/** Why the open database refuses changes, null while it accepts them. */
let readOnly: { reason: ReadOnlyReason; facts: DatabaseFacts } | null = null;

export type DatabaseAccess = {
  /** Creates the database when the store has none. Only operations that need no existing record pass it. */
  createsDatabase?: boolean;
};

const INITIALIZATION_RETRY_BUDGET_MS = 1_000;
const INITIALIZATION_ATTEMPTS = 5;

/** Closes the cached connection before clearing process state for internal tests. */
export function resetDatabaseForTests() {
  db?.close();
  db = null;
  policy = DEFAULT_OPEN_POLICY;
  readOnly = null;
  resetStorageForTests();
}

/** Sets how core opens the database. A client calls it once, before anything opens the database. */
export function configureDatabase(openPolicy: OpenPolicy) {
  if (db != null) {
    throw new Error(
      "The database is already open, so the policy for opening it can no longer change",
    );
  }

  policy = openPolicy;
}

type Prepared = DatabaseClassification & { decision: OpenDecision };

function isWritable(decision: OpenDecision) {
  return (
    decision.action === "create" || decision.action === "write" || decision.action === "upgrade"
  );
}

/**
 * Classifies the database and decides how it opens. Writes stay blocked by `query_only`
 *  until the decision allows them, so nothing can write before the state is known.
 * An empty database counts as missing unless the access creates one.
 */
function prepare(
  connection: Database,
  { createsDatabase = false }: DatabaseAccess,
  storage: Storage,
): Prepared {
  connection.exec("PRAGMA query_only = ON");

  const classification = classifyConnection(connection, MIGRATIONS);
  const decision = decideOpen({
    state: classification.state,
    isProtectedDatabase: () => isProtectedStorage(storage),
    coreRelease: readCoreReleaseMode(),
    clientRelease: policy.release,
    allowsLegacyRead: policy.allowsLegacyRead,
  });

  if (decision.action === "create" && !createsDatabase) {
    throw new MissingDatabaseError(storage.databasePath);
  }

  if (isWritable(decision)) {
    connection.exec("PRAGMA query_only = OFF");
    connection.exec("PRAGMA journal_mode = WAL;");
    connection.exec("PRAGMA foreign_keys = true;");
    // TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup
  }

  return { ...classification, decision };
}

function openConnection(access: DatabaseAccess, storage: Storage) {
  // Without the create flag, the open never creates a file
  const connection = openResolvedDatabase(storage.databasePath, {
    create: access.createsDatabase === true,
  });

  try {
    // Arm waiting before reading the state or switching to WAL can encounter another process.
    applyConnectionSettings(connection);
    return { connection, ...prepare(connection, access, storage) };
  } catch (err) {
    try {
      connection.close();
    } catch (closeError) {
      attachSuppressed(err, closeError);
    }

    throw err;
  }
}

/** Opens the connection, retrying only the startup races that SQLite's busy handler does not cover. */
function openWithRetries(access: DatabaseAccess, storage: Storage) {
  const began = performance.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return openConnection(access, storage);
    } catch (err) {
      // Binding and API errors are not SqliteErrors, so they are never retried.
      const isTransientStartupError =
        isSqliteErrorCode(err, "SQLITE_BUSY") ||
        isSqliteErrorCode(err, "SQLITE_BUSY_RECOVERY") ||
        isSqliteErrorCode(err, "SQLITE_IOERR_TRUNCATE");
      const retryBudgetExhausted =
        attempt >= INITIALIZATION_ATTEMPTS ||
        performance.now() - began >= INITIALIZATION_RETRY_BUDGET_MS;

      if (!isTransientStartupError || retryBudgetExhausted) {
        throw err;
      }

      // Some startup races bypass SQLite's busy handler. Do not repeat a long wait.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

/**
 * Carries out the decision by either creating a fresh database, upgrading an older one or keeping it read-only.
 * Creation and upgrades run only once without retries, so as not to repeat failures.
 * Returns why the database refuses changes, or `null`.
 */
function settle(connection: Database, prepared: Prepared, storage: Storage): typeof readOnly {
  const facts: DatabaseFacts = {
    databasePath: storage.databasePath,
    version: prepared.version,
    latestVersion: prepared.latestVersion,
  };
  const { decision } = prepared;

  switch (decision.action) {
    case "write":
      return null;
    case "read-only":
      if (decision.reason === "unmarked") {
        policy.onLegacyRead?.(facts);
      }

      return { reason: decision.reason, facts };
    case "refuse":
      throw new UnmarkedDatabaseError(facts);
    case "create":
      try {
        createSchema(connection, MIGRATIONS);
        return null;
      } catch (error) {
        if (!(error instanceof SchemaNotEmptyError)) {
          throw error;
        }

        // Another process created the database first, so open it as it is now.
        const reclassified = prepare(connection, { createsDatabase: true }, storage);
        if (reclassified.decision.action === "create") {
          throw error;
        }

        return settle(connection, reclassified, storage);
      }
    case "upgrade": {
      const { backupDirectory } = getBackupStorage(storage);
      const { status, previousVersion } = upgradeDatabase(connection, {
        backup: {
          directory: backupDirectory,
          client: policy.client,
          version: policy.version,
        },
        migrations: MIGRATIONS,
        onWait: policy.onWait,
      });

      // Another process may have upgraded it beyond this build while this one waited.
      if (status === "newer") {
        connection.exec("PRAGMA query_only = ON");
        return { reason: "newer", facts: { ...facts, version: previousVersion } };
      }

      return null;
    }
  }
}

/** Opens the database once per process. Without `createsDatabase`, a store with no database throws MissingDatabaseError. */
export function getDb(access: DatabaseAccess = {}) {
  if (db == null) {
    // Resolved outside the try, so a refused folder is reported as it is, not as a problem initializing Zinn.
    const storage = getStorage();
    const { databasePath } = storage;
    let connection: Database | null = null;

    try {
      const isMissing = !existsSync(databasePath);

      if (isMissing && access.createsDatabase !== true) {
        throw new MissingDatabaseError(databasePath);
      }

      // The data directory is created only for a store that does not exist yet.
      if (isMissing) {
        ensureDataDirectory(storage);
      }

      const opened = openWithRetries(access, storage);
      connection = opened.connection;
      readOnly = settle(connection, opened, storage);
      db = connection;
    } catch (err) {
      if (connection != null) {
        try {
          connection.close();
        } catch (closeError) {
          attachSuppressed(err, closeError);
        }
      }

      if (err instanceof UnmarkedDatabaseError || err instanceof MissingDatabaseError) {
        throw err;
      }

      const error = err as NodeJS.ErrnoException;
      const causeDetails = error.code == null ? error.message : `${error.message} (${error.code})`;
      throw new Error(`There was a problem initializing Zinn: ${causeDetails}`, { cause: err });
    }
  }

  return db;
}

/** Throws before any SQL runs when the database opened read-only. */
export function assertWritable() {
  getDb();

  if (readOnly != null) {
    throw new ReadOnlyDatabaseError(readOnly.reason, readOnly.facts, policy);
  }
}

/**
 * Runs fn in one write transaction once the database accepts changes. Every core mutation uses it.
 * The outermost call runs the configured hooks after the commit, and a nested call runs inside it.
 */
export function writeTransaction<T>(fn: () => T): T {
  assertWritable();
  const connection = getDb();
  const write = () => {
    try {
      return connection.transaction(fn).immediate();
    } catch (error) {
      rethrowSearchError(error);
    }
  };

  return connection.inTransaction ? write() : withChangeHooks(write);
}

/** Runs fn in one deferred transaction, so every read inside sees the same snapshot. */
export function readTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).deferred();
}
