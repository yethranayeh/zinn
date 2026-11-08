import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { TELEMETRY_FOLDER_NAME } from "../core/src/constant";
import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { createSchema } from "../core/src/migrations/runner";
import { openDatabase } from "../core/src/sqlite/bun";
import { runProcessAsync } from "./testing";

export { runProcessAsync };

const PREFIX = join(tmpdir(), "zinntest-");
export const CLI_PATH = join(import.meta.dir, "index.ts");

function removeIsolatedZinnDir(testDir: string) {
  if (!testDir.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${testDir}": not a ${PREFIX}* directory`);
  }

  rmSync(testDir, { recursive: true, force: true });
}

export async function withIsolatedZinnDir(run: (testDir: string) => Promise<void>) {
  const testDir = mkdtempSync(PREFIX);

  try {
    await run(testDir);
  } finally {
    removeIsolatedZinnDir(testDir);
  }
}

/** Drops the telemetry folder, and everything under it, from a store folder listing read top-level or recursively */
export function withoutTelemetry(entries: Array<string>) {
  return entries.filter((entry) => entry.split(sep)[0] !== TELEMETRY_FOLDER_NAME);
}

export function runZinn(
  args: Array<string>,
  testDir: string,
  additionalEnv: Record<string, string> = {},
) {
  return runProcessAsync([process.execPath, CLI_PATH, ...args], {
    env: { ...TEST_ENVIRONMENT, ...additionalEnv, ZINN_DIR: testDir },
    cwd: testDir,
  });
}

// ? Pipes "y" into the CLI, as a script would; it does not answer a confirmation.
export function runZinnWithPipedYes(args: Array<string>, testDir: string) {
  return runProcessAsync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", CLI_PATH, ...args],
    { env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir }, cwd: testDir },
  );
}

/** Creates a database at the latest schema with no records or activity. */
export function createEmptyDatabase(testDir: string) {
  mkdirSync(join(testDir, "data"), { recursive: true });
  const db = openDatabase(join(testDir, "data", "zinn.sqlite"));

  try {
    createSchema(db);
  } finally {
    db.close();
  }
}

export function withTestDb<T>(testDir: string, inspect: (db: Database) => T) {
  const db = new Database(join(testDir, "data", "zinn.sqlite"));
  db.run("PRAGMA foreign_keys = ON;");

  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

export function backupFiles(dir: string) {
  return existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : [];
}

// ? Rows, schema and version, to prove a refused migrate wrote nothing.
export function databaseSnapshot(dir: string) {
  return withTestDb(dir, (db) => ({
    version: db.query("PRAGMA user_version").get(),
    schema: db.query("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    projects: db.query("SELECT * FROM project").all(),
    tasks: db.query("SELECT * FROM task").all(),
  }));
}

export async function createDatabase(dir: string, version: number) {
  await runZinn(["project", "create", "MIG"], dir);
  await runZinn(["task", "create", "MIG", "--title", "Kept"], dir);
  withTestDb(dir, (db) => db.run(`PRAGMA user_version = ${version}`));
}
