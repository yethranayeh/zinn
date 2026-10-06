import type { Database } from "./sqlite/database";
import type { DatabaseClassification } from "./migrations/classify";
import type {
  DatabaseFacts,
  OpenDecision,
  OpenPolicy,
  ReadOnlyReason,
} from "./migrations/open-policy";

import { existsSync } from "node:fs";

import { openDatabase } from "#sqlite";

import { BACKUP_DIR, DB_PATH, DEFAULT_MAIN_DIR, MAIN_DIR } from "./constant";
import { ensureConfigSetup } from "./config";
import { applyConnectionSettings } from "./connection";
import { classifyConnection } from "./migrations/classify";
import {
  decideOpen,
  DEFAULT_OPEN_POLICY,
  isDefaultDatabase,
  ReadOnlyDatabaseError,
  UnmarkedDatabaseError,
} from "./migrations/open-policy";
import { MIGRATIONS } from "./migrations/registry";
import { createSchema, SchemaNotEmptyError } from "./migrations/runner";
import { upgradeDatabase } from "./migrations/upgrade";
import { readCoreReleaseMode } from "./release";
import { attachSuppressed, SqliteError } from "./sqlite/database";

let db: Database | null = null;
let policy: OpenPolicy = DEFAULT_OPEN_POLICY;
/** Why the open database refuses changes, null while it accepts them. */
let readOnly: { reason: ReadOnlyReason; facts: DatabaseFacts } | null = null;

const INITIALIZATION_RETRY_BUDGET_MS = 1_000;
const INITIALIZATION_ATTEMPTS = 5;

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
 */
function prepare(connection: Database): Prepared {
  connection.exec("PRAGMA query_only = ON");

  const classification = classifyConnection(connection, MIGRATIONS);
  const decision = decideOpen({
    state: classification.state,
    isDefaultDatabase: () => isDefaultDatabase(MAIN_DIR, DEFAULT_MAIN_DIR),
    coreRelease: readCoreReleaseMode(),
    clientRelease: policy.release,
    allowsLegacyRead: policy.allowsLegacyRead,
  });

  if (isWritable(decision)) {
    connection.exec("PRAGMA query_only = OFF");
    connection.exec("PRAGMA journal_mode = WAL;");
    connection.exec("PRAGMA foreign_keys = true;");
    // TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup
  }

  return { ...classification, decision };
}

function openConnection() {
  const connection = openDatabase(DB_PATH);

  try {
    // Arm waiting before reading the state or switching to WAL can encounter another process.
    applyConnectionSettings(connection);
    return { connection, ...prepare(connection) };
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
function openWithRetries() {
  const began = performance.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return openConnection();
    } catch (err) {
      // Binding and API errors are not SqliteErrors, so they are never retried.
      const code = err instanceof SqliteError ? err.code : null;
      const isTransientStartupError =
        code === "SQLITE_BUSY" ||
        code === "SQLITE_BUSY_RECOVERY" ||
        code === "SQLITE_IOERR_TRUNCATE";
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
function settle(connection: Database, prepared: Prepared): typeof readOnly {
  const facts: DatabaseFacts = {
    databasePath: DB_PATH,
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
        const reclassified = prepare(connection);
        if (reclassified.decision.action === "create") {
          throw error;
        }

        return settle(connection, reclassified);
      }
    case "upgrade": {
      const { status, previousVersion } = upgradeDatabase(connection, {
        backup: { directory: BACKUP_DIR, client: policy.client, version: policy.version },
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

export function getDb() {
  if (db == null) {
    let connection: Database | null = null;

    try {
      // **settings.json** is written only for a store this creates.
      if (!existsSync(DB_PATH)) {
        ensureConfigSetup();
      }

      const opened = openWithRetries();
      connection = opened.connection;
      readOnly = settle(connection, opened);
      db = connection;
    } catch (err) {
      if (connection != null) {
        try {
          connection.close();
        } catch (closeError) {
          attachSuppressed(err, closeError);
        }
      }

      if (err instanceof UnmarkedDatabaseError) {
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

/** Runs fn in one write transaction once the database accepts changes. Every core mutation uses it. */
export function writeTransaction<T>(fn: () => T): T {
  assertWritable();
  return getDb().transaction(fn).immediate();
}
