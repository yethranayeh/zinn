/**
 * Shared pieces of the migration scenarios: an older store to start from, CLI commands that run
 *  with the test-only migration, the migration's event log, and checks on what an upgrade leaves.
 */
import type { Database } from "../../packages/core/src/sqlite/database.ts";
import type { RunDirectory } from "./harness.ts";

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readSchemaVersion } from "../../packages/core/src/migrations/runner.ts";
import { snapshot } from "../../packages/core/src/migrations/testing.ts";
import { CLI_ENTRY, CORE_WORKER, runToCompletion, sleep } from "./harness.ts";
import { MIGRATION_EVENTS, STRESS_MIGRATION } from "./stress-migration.ts";
import { checkZinnInvariants, openForChecks, withDatabase } from "./zinn-checks.ts";

export const MIGRATION_PRELOAD = join(import.meta.dir, "migration-preload.ts");
/** The version a store made without the preload has, and the version the test migration brings it to. */
export const OLDER_VERSION = STRESS_MIGRATION.version - 1;
export const UPGRADED_VERSION = STRESS_MIGRATION.version;

const SEED_TIMEOUT_MS = 180_000;
const EVENT_POLL_MS = 10;
const SEARCH_SHADOW_PREFIX = "task_search_";
// What the CLI prints on stderr once, when a command starts waiting for another process's upgrade.
export const LOCK_WAIT_MESSAGE =
  "Another process is using the database. Waiting up to 30 seconds for it to finish.";

/** The real CLI, with the test-only migration added to core's chain. */
export function migratingCliCommand(args: Array<string>) {
  return ["bun", "--preload", MIGRATION_PRELOAD, CLI_ENTRY, ...args];
}

export function databasePathOf(zinnDirectory: string) {
  return join(zinnDirectory, "data", "zinn.sqlite");
}

export function backupDirectoryOf(zinnDirectory: string) {
  return join(zinnDirectory, "backups");
}

export type OlderStore = { template: string; before: StoreRows; taskCount: number };

const templates = new WeakMap<RunDirectory, Map<number, OlderStore>>();

/**
 * A store at the version before the test migration, populated through core with tasks, comments,
 *  labels and relations (no preload, so it is made at version 1). Built once per size and copied.
 */
export async function olderStoreTemplate(
  run: RunDirectory,
  taskCount: number,
  seed: number,
): Promise<OlderStore> {
  const known = templates.get(run) ?? new Map<number, OlderStore>();
  templates.set(run, known);

  const existing = known.get(taskCount);
  if (existing != null) {
    return existing;
  }

  const template = run.create("migration-template");
  const seeded = await runToCompletion(
    [
      "bun",
      CORE_WORKER,
      "--mode",
      "seed-linked",
      "--tasks",
      String(taskCount),
      "--seed",
      String(seed),
    ],
    template,
    SEED_TIMEOUT_MS,
  );
  if (seeded.exitCode !== 0) {
    throw new Error(`Seeding the older store failed: ${seeded.stderr}`);
  }

  // One file is easy to copy: fold the -wal file in and remove the sidecars.
  const databasePath = databasePathOf(template);
  const before = withDatabase(databasePath, (db) => {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return readRows(db);
  });
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }

  const store = { template, before, taskCount };
  known.set(taskCount, store);
  return store;
}

/** A new isolated store directory holding a copy of the older store. */
export function copyOlderStore(run: RunDirectory, store: OlderStore, label: string) {
  const directory = run.create(label);
  mkdirSync(join(directory, "data"));
  copyFileSync(databasePathOf(store.template), databasePathOf(directory));
  return directory;
}

export type StoreRows = {
  version: number;
  schema: Array<string>;
  rows: Record<string, Array<string>>;
};

/** Logical rows without FTS shadow tables; exact snapshots also include schema SQL and rowids. */
export function readRows(db: Database, exact = false): StoreRows {
  const { version, schema, rows } = snapshot(db);
  const tables = Object.keys(rows).filter((table) => !table.startsWith(SEARCH_SHADOW_PREFIX));
  const rowidTables = exact
    ? new Set(
        db
          .query<{ name: string }>(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' AND wr = 0",
          )
          .all()
          .map(({ name }) => name),
      )
    : new Set<string>();

  return {
    version,
    schema: schema
      .filter((object) => !object.name.startsWith(SEARCH_SHADOW_PREFIX))
      .map((object) => (exact ? JSON.stringify(object) : `${object.type} ${object.name}`))
      .sort(),
    rows: Object.fromEntries(
      tables.map((table) => {
        const found = rowidTables.has(table)
          ? db.query(`SELECT rowid AS __rowid, * FROM ${table}`).all()
          : rows[table]!;
        return [table, found.map((row) => JSON.stringify(row)).sort()];
      }),
    ),
  };
}

// Creates add task/activity rows and rewrite search; the project counter is compared separately.
const GROWING_BY_CREATES = new Set(["task", "activity"]);
const REWRITTEN_BY_CREATES = new Set(["task_search"]);

/**
 * Compares a store with the older rows it came from. Every table must hold exactly the older rows,
 *  except that task creates and, with `allowsComments`, comment creates may add rows and increment
 *  counters. Older content must remain; invariants check counters and rewritten search rows.
 */
export function compareWithOlder(
  before: StoreRows,
  after: StoreRows,
  allowsNewRows: boolean,
  allowsComments = false,
) {
  const problems: Array<string> = [];

  for (const [table, oldRows] of Object.entries(before.rows)) {
    const newRows = after.rows[table];
    const rewritesSearch =
      (allowsNewRows && REWRITTEN_BY_CREATES.has(table)) ||
      (allowsComments && table === "task_search");
    const addsRows =
      (allowsNewRows && GROWING_BY_CREATES.has(table)) ||
      (allowsComments && ["task", "comment", "activity"].includes(table));
    if (newRows == null) {
      problems.push(`table ${table} is gone`);
    } else if (allowsNewRows && table === "project") {
      const withoutCounter = (row: string) => {
        const { task_count, ...unchanged } = JSON.parse(row);
        return JSON.stringify(unchanged);
      };
      const oldFields = oldRows.map(withoutCounter).sort();
      const newFields = newRows.map(withoutCounter).sort();
      if (JSON.stringify(oldFields) !== JSON.stringify(newFields)) {
        problems.push("project fields other than task_count changed");
      }
    } else if (rewritesSearch) {
      continue;
    } else if (addsRows) {
      const normalize = (row: string) => {
        if (allowsComments && table === "task") {
          const { comment_count, ...unchanged } = JSON.parse(row);
          return JSON.stringify(unchanged);
        }
        return row;
      };
      const present = new Set(newRows.map(normalize));
      const lost = oldRows.filter((row) => !present.has(normalize(row)));
      if (lost.length > 0) {
        problems.push(
          `${lost.length} older ${table} row(s) changed or are missing, first ${lost[0]!.slice(0, 160)}`,
        );
      }
    } else if (JSON.stringify(newRows) !== JSON.stringify(oldRows)) {
      problems.push(
        `table ${table} differs from before the upgrade (${oldRows.length} rows before, ${newRows.length} after)`,
      );
    }
  }

  const objectsAfter = new Set(after.schema);
  const missing = before.schema.filter((object) => !objectsAfter.has(object));
  if (missing.length > 0) {
    problems.push(`schema objects are gone: ${missing.join(", ")}`);
  }

  return problems;
}

/** Exact logical equality, including extra tables and schema objects. */
export function compareStores(before: StoreRows, after: StoreRows) {
  const problems = compareWithOlder(before, after, false);
  if (before.version !== after.version) {
    problems.push(`schema version ${after.version}, expected ${before.version}`);
  }
  if (JSON.stringify(before.schema) !== JSON.stringify(after.schema)) {
    problems.push("schema definitions differ");
  }
  const extraTables = Object.keys(after.rows).filter((table) => !(table in before.rows));
  if (extraTables.length > 0) {
    problems.push(`extra tables: ${extraTables.join(", ")}`);
  }
  return problems;
}

/**
 * Opens every file in the backups directory read-only: a final-name file must be a complete database
 *  at the older version holding the older rows. Unfinished files are allowed only when requested.
 */
export function checkBackups(
  zinnDirectory: string,
  before: StoreRows,
  { allowsPartial = false, exact = false } = {},
): { names: Array<string>; problems: Array<string> } {
  const directory = backupDirectoryOf(zinnDirectory);
  const names = existsSync(directory) ? readdirSync(directory).sort() : [];
  const problems: Array<string> = [];

  for (const name of names) {
    if (!name.endsWith(".sqlite")) {
      const isPartial =
        name.endsWith(".sqlite.partial") || name.endsWith(".sqlite.partial-journal");
      if (allowsPartial && isPartial) {
        continue;
      }
      problems.push(`backup directory holds ${name}, which is not a finished backup`);
      continue;
    }

    try {
      const rows = withDatabase(join(directory, name), (db) => {
        const found = checkZinnInvariants(db);
        for (const problem of found) {
          problems.push(`backup ${name}: ${problem}`);
        }
        return readRows(db, exact);
      });

      if (rows.version !== before.version) {
        problems.push(
          `backup ${name} has schema version ${rows.version}, expected ${before.version}`,
        );
      }
      for (const problem of exact
        ? compareStores(before, rows)
        : compareWithOlder(before, rows, false)) {
        problems.push(`backup ${name}: ${problem}`);
      }
    } catch (error) {
      problems.push(`backup ${name} cannot be read: ${(error as Error).message}`);
    }
  }

  return { names, problems };
}

/** Checks a store the upgrade finished: its version, its invariants and its rows against the older ones. */
export function checkUpgraded(zinnDirectory: string, before: StoreRows, allowsNewRows: boolean) {
  const db = openForChecks(databasePathOf(zinnDirectory));

  try {
    const problems = checkZinnInvariants(db);
    const version = readSchemaVersion(db);
    if (version !== UPGRADED_VERSION) {
      problems.push(`schema version is ${version}, expected ${UPGRADED_VERSION}`);
    }
    problems.push(...compareWithOlder(before, readRows(db), allowsNewRows));
    return problems;
  } finally {
    db.close();
  }
}

/**
 * The full-text index's own consistency check, plus a search that must find every seeded task.
 * The seeded titles all start with "seeded", and the check writes nothing.
 * @link https://www.sqlite.org/fts5.html#the_integrity_check_command
 */
export function checkSearchIndex(db: Database, taskCount: number) {
  try {
    db.exec("INSERT INTO task_search(task_search) VALUES ('integrity-check')");
    const found = db
      .query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_search WHERE task_search MATCH 'seeded'",
      )
      .get()!.count;
    return found === taskCount
      ? []
      : [`search for "seeded" finds ${found} tasks, expected ${taskCount}`];
  } catch (error) {
    return [`search index: ${(error as Error).message}`];
  }
}

export type MigrationEventRecord = { at: number; pid: number; event: string };

export function readEvents(
  eventsFile: string,
  acceptedEvents: ReadonlyArray<string> = MIGRATION_EVENTS,
): Array<MigrationEventRecord> {
  if (!existsSync(eventsFile)) {
    return [];
  }

  return readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [at, pid, event] = line.split(" ");
      return { at: Number(at), pid: Number(pid), event: event! };
    })
    .filter((record) => acceptedEvents.includes(record.event));
}

/** Resolves true once the event has been logged by some process, false when the wait times out. */
export async function waitForEvent(
  eventsFile: string,
  event: string,
  timeoutMs: number,
  acceptedEvents: ReadonlyArray<string> = MIGRATION_EVENTS,
) {
  const began = performance.now();

  while (performance.now() - began < timeoutMs) {
    if (readEvents(eventsFile, acceptedEvents).some((record) => record.event === event)) {
      return true;
    }
    await sleep(EVENT_POLL_MS);
  }

  return false;
}

/** How many times the test migration's apply started, across every process. */
export function countMigrationStarts(eventsFile: string) {
  return readEvents(eventsFile).filter((record) => record.event === "start").length;
}

/** What a CLI command printed as an error, for messages and counting. */
export function errorMessageOf(stderr: string) {
  const json = stderr.slice(stderr.indexOf("{"));

  try {
    return (JSON.parse(json) as { error: { message: string } }).error.message;
  } catch {
    return stderr.trim().slice(0, 300);
  }
}
