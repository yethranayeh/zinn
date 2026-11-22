import type { SettingsInputs } from "../settings.js";
import type { Database } from "../sqlite/database.js";
import type { DatabaseState } from "../migrations/classify.js";
import type { StoreInfo } from "./info.js";

import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

import { errorMessage } from "../errors.js";
import { checkIntegrity, inspectClassifiedDatabase } from "../migrations/classify.js";
import { findForeignKeyViolations, findMissingParentTables } from "../migrations/runner.js";
import { readSearchEntries } from "../migrations/search.js";
import { createFolderCommand } from "../storage.js";
import { inspectStoreDatabase, inspectStoreFiles } from "./info.js";

export const doctorStatusSchema = z.enum(["ok", "warning", "problem"]);
export const doctorCheckIdSchema = z.enum([
  "settings",
  "store_folder",
  "database",
  "integrity",
  "foreign_keys",
  "search_index",
]);

export type DoctorStatus = z.infer<typeof doctorStatusSchema>;
export type DoctorCheck<Id extends string = z.infer<typeof doctorCheckIdSchema>> = {
  id: Id;
  status: DoctorStatus;
  message: string;
  /** What to do about a warning or problem, `null` when the check is ok. */
  remedy: string | null;
};

const RESTORE_REMEDY = "Restore a backup with `zinn restore <backup-file>`";

/** Database states whose tables doctor reads. A database that is absent, empty or unreadable has none to check. */
const STATES_WITH_TABLES = new Set<DatabaseState>(["unmarked", "older", "current", "newer"]);

function ok(id: DoctorCheck["id"], message: string): DoctorCheck {
  return { id, status: "ok", message, remedy: null };
}

function settingsCheck(report: StoreInfo): DoctorCheck {
  const unusable = report.settingsFiles.flatMap((file) => (file.state === "error" ? [file] : []));

  if (unusable.length === 0) {
    return ok("settings", "Every settings file Zinn reads is usable");
  }

  const paths = unusable.map((file) => file.path).join(", ");
  return {
    id: "settings",
    status: "problem",
    message: unusable.map((file) => `${file.path} cannot be used: ${file.error}`).join(". "),
    remedy: `Correct or remove ${paths}`,
  };
}

function storeFolderCheck(storage: StoreInfo["storage"], directory: string): DoctorCheck {
  const isDefaultAndMissing =
    storage.source === "default" && storage.exists === false && storage.error === null;

  if (storage.exists === true) {
    return ok("store_folder", "The store folder exists");
  }

  if (isDefaultAndMissing) {
    return ok(
      "store_folder",
      "The default store folder does not exist yet. Zinn creates it on the first change",
    );
  }

  return {
    id: "store_folder",
    status: "problem",
    message: `Cannot use the store folder ${directory}: ${storage.error ?? "it does not exist"}`,
    remedy: `Create the folder with \`${createFolderCommand(directory)}\``,
  };
}

function databaseCheck(database: StoreInfo["database"]): DoctorCheck {
  if (database.error !== null) {
    return {
      id: "database",
      status: "problem",
      message: `The database cannot be read: ${database.error}`,
      remedy: RESTORE_REMEDY,
    };
  }

  switch (database.state) {
    case "absent":
    case "empty":
      return ok("database", "There is no database yet. Zinn creates it on the first change");
    case "current":
      return ok("database", "The database has the latest schema version");
    case "older":
      return ok(
        "database",
        "The database has an older schema version. The next change upgrades it, and `zinn migrate` upgrades it now",
      );
    case "newer":
      return {
        id: "database",
        status: "problem",
        message: "The database has a newer schema version than this Zinn supports",
        remedy: "Upgrade Zinn to a newer version",
      };
    case "unmarked":
      return {
        id: "database",
        status: "problem",
        message:
          "The database has no schema version, and Zinn opens only databases that record one",
        remedy: RESTORE_REMEDY,
      };
    case "unavailable":
      return {
        id: "database",
        status: "problem",
        message: "The database cannot be read",
        remedy: RESTORE_REMEDY,
      };
  }
}

function readFailure(id: DoctorCheck["id"], error: unknown): DoctorCheck {
  return {
    id,
    status: "problem",
    message: `The check could not read the database: ${errorMessage(error)}`,
    remedy: RESTORE_REMEDY,
  };
}

/** Runs one database check, turning a failure while reading into that check's problem. */
function runDatabaseCheck(id: DoctorCheck["id"], check: () => DoctorCheck): DoctorCheck {
  try {
    return check();
  } catch (error) {
    return readFailure(id, error);
  }
}

function integrityCheck(db: Database): DoctorCheck {
  const { isSound, rows } = checkIntegrity(db);

  if (isSound) {
    return ok("integrity", "SQLite's integrity check passed");
  }

  return {
    id: "integrity",
    status: "problem",
    message: `SQLite's integrity check reported ${rows.length} problems: ${rows.join(", ")}`,
    remedy: RESTORE_REMEDY,
  };
}

function foreignKeysCheck(db: Database): DoctorCheck {
  const violations = findForeignKeyViolations(db);
  const missingParents = findMissingParentTables(db);

  if (violations.length === 0 && missingParents.length === 0) {
    return ok("foreign_keys", "Every row link points to an existing row");
  }

  const findings: Array<string> = [];

  if (violations.length > 0) {
    const links = new Set(violations.map(({ table, parent }) => `${table} to ${parent}`));
    findings.push(`${violations.length} rows link to missing rows (${[...links].join(", ")})`);
  }

  if (missingParents.length > 0) {
    const links = missingParents.map(({ child, parent }) => `${child} to ${parent}`);
    findings.push(`links point to missing tables (${links.join(", ")})`);
  }

  return {
    id: "foreign_keys",
    status: "problem",
    message: findings.join(", and "),
    remedy: RESTORE_REMEDY,
  };
}

type StoredEntry = { title: string; description: string | null; comments: string };

function hasSearchTable(db: Database) {
  return (
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_search'").get() !==
    null
  );
}

/** Compares the search index with the entries `zinn reindex` would write, in both directions */
function searchIndexCheck(db: Database): DoctorCheck {
  const reindexRemedy = "Rebuild the search index with `zinn reindex`";

  if (!hasSearchTable(db)) {
    return {
      id: "search_index",
      status: "warning",
      message: "The search index table is missing",
      remedy: reindexRemedy,
    };
  }

  const stored = new Map<string, Array<StoredEntry>>();
  const rows = db
    .query<StoredEntry & { task_id: string }>(
      "SELECT task_id, title, description, comments FROM task_search",
    )
    .all();

  for (const { task_id, ...entry } of rows) {
    const entries = stored.get(task_id) ?? [];
    entries.push(entry);
    stored.set(task_id, entries);
  }

  let missingCount = 0;
  let outdatedCount = 0;
  let extraCount = 0;

  for (const expected of readSearchEntries(db)) {
    const entries = stored.get(expected.taskId);
    stored.delete(expected.taskId);

    if (entries === undefined) {
      missingCount += 1;
      continue;
    }

    extraCount += entries.length - 1;
    const isOutdated = entries.some(
      (entry) =>
        entry.title !== expected.title ||
        entry.description !== expected.description ||
        entry.comments !== expected.comments,
    );

    if (isOutdated) {
      outdatedCount += 1;
    }
  }

  for (const entries of stored.values()) {
    extraCount += entries.length;
  }

  if (missingCount === 0 && outdatedCount === 0 && extraCount === 0) {
    return ok("search_index", "The search index matches every task");
  }

  return {
    id: "search_index",
    status: "warning",
    message: `The search index differs from the tasks. Tasks without an entry: ${missingCount}. Entries out of date: ${outdatedCount}. Entries for no task or repeating one: ${extraCount}`,
    remedy: reindexRemedy,
  };
}

/** Reads the database's tables once for the integrity, foreign key and search checks */
function tableChecks(db: Database, state: DatabaseState): Array<DoctorCheck> {
  const checks = [
    runDatabaseCheck("integrity", () => integrityCheck(db)),
    runDatabaseCheck("foreign_keys", () => foreignKeysCheck(db)),
  ];

  if (state === "current") {
    checks.push(runDatabaseCheck("search_index", () => searchIndexCheck(db)));
  }

  return checks;
}

export const doctor = {
  /**
   * Checks the selected settings and database without changing them. Checks that cannot run because
   *  an earlier one failed are left out.
   */
  check(
    inputs: SettingsInputs = { cwd: process.cwd(), env: process.env, home: homedir() },
  ): Array<DoctorCheck> {
    const report = inspectStoreFiles(inputs);
    const settings = settingsCheck(report);
    const checks = [settings];

    // Every connection takes its waiting time from the settings, so no later check can run without them.
    if (settings.status !== "ok" || report.storage.directory === null) {
      return checks;
    }

    const storeFolder = storeFolderCheck(
      report.storage,
      resolve(inputs.cwd, report.storage.directory),
    );
    checks.push(storeFolder);

    if (storeFolder.status !== "ok") {
      return checks;
    }

    let databaseTableChecks: Array<DoctorCheck> = [];
    inspectStoreDatabase(report, inputs.cwd, (databasePath) =>
      inspectClassifiedDatabase(databasePath, (classification, db) => {
        if (db !== null && STATES_WITH_TABLES.has(classification.state)) {
          databaseTableChecks = tableChecks(db, classification.state);
        }
        return classification;
      }),
    );

    checks.push(databaseCheck(report.database));
    if (report.database.error === null) {
      checks.push(...databaseTableChecks);
    }

    return checks;
  },
};
