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
import { MIGRATION_EVENTS, type MigrationEvent, STRESS_MIGRATION } from "./stress-migration.ts";
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

/** The version, the schema and every table's rows as sorted strings, without the search index's internal tables. */
export function readRows(db: Database): StoreRows {
  const { version, schema, rows } = snapshot(db);
  const tables = Object.keys(rows).filter((table) => !table.startsWith(SEARCH_SHADOW_PREFIX));

  return {
    version,
    schema: schema
      .filter((object) => !object.name.startsWith(SEARCH_SHADOW_PREFIX))
      .map((object) => `${object.type} ${object.name}`)
      .sort(),
    rows: Object.fromEntries(
      tables.map((table) => [table, rows[table]!.map((row) => JSON.stringify(row)).sort()]),
    ),
  };
}

// Task creates add rows to these tables, and rewrite the other two (the counter, the search row).
const GROWING_BY_CREATES = new Set(["task", "activity"]);
const REWRITTEN_BY_CREATES = new Set(["project", "task_search"]);

/**
 * Compares a store with the older rows it came from. Every table must hold exactly the older rows,
 *  except that with `allowsNewRows` (ordinary writers ran too) the tables a task create changes may
 *  have more: older rows must all still be there, and invariants cover the rewritten ones.
 */
export function compareWithOlder(before: StoreRows, after: StoreRows, allowsNewRows: boolean) {
  const problems: Array<string> = [];

  for (const [table, oldRows] of Object.entries(before.rows)) {
    const newRows = after.rows[table];
    if (newRows == null) {
      problems.push(`table ${table} is gone`);
    } else if (allowsNewRows && REWRITTEN_BY_CREATES.has(table)) {
      continue;
    } else if (allowsNewRows && GROWING_BY_CREATES.has(table)) {
      const present = new Set(newRows);
      const lost = oldRows.filter((row) => !present.has(row));
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

/**
 * Opens every file in the backups directory read-only: a final-name file must be a complete database
 *  at the older version holding exactly the older rows. Leftover `.partial` files are reported by name.
 */
export function checkBackups(
  zinnDirectory: string,
  before: StoreRows,
): { names: Array<string>; problems: Array<string> } {
  const directory = backupDirectoryOf(zinnDirectory);
  const names = existsSync(directory) ? readdirSync(directory).sort() : [];
  const problems: Array<string> = [];

  for (const name of names) {
    if (!name.endsWith(".sqlite")) {
      problems.push(`backup directory holds ${name}, which is not a finished backup`);
      continue;
    }

    try {
      const rows = withDatabase(join(directory, name), (db) => {
        const found = checkZinnInvariants(db);
        for (const problem of found) {
          problems.push(`backup ${name}: ${problem}`);
        }
        return readRows(db);
      });

      if (rows.version !== before.version) {
        problems.push(
          `backup ${name} has schema version ${rows.version}, expected ${before.version}`,
        );
      }
      for (const problem of compareWithOlder(before, rows, false)) {
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

export type MigrationEventRecord = { at: number; pid: number; event: MigrationEvent };

export function readEvents(eventsFile: string): Array<MigrationEventRecord> {
  if (!existsSync(eventsFile)) {
    return [];
  }

  return readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [at, pid, event] = line.split(" ");
      return { at: Number(at), pid: Number(pid), event: event as MigrationEvent };
    })
    .filter((record) => MIGRATION_EVENTS.includes(record.event));
}

/** Resolves true once the event has been logged by some process, false when the wait times out. */
export async function waitForEvent(eventsFile: string, event: MigrationEvent, timeoutMs: number) {
  const began = performance.now();

  while (performance.now() - began < timeoutMs) {
    if (readEvents(eventsFile).some((record) => record.event === event)) {
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
