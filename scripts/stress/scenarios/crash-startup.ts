/**
 * Scenarios for the sensitive moments outside ordinary operations, both through the real CLI:
 *
 *   crash-init    SIGKILL the very first command on a new ZINN_DIR, at a random moment between process
 *                 start and exit: directory and settings.json creation, file creation, WAL setup and
 *                 schema creation. Then check what was left and that the next commands work.
 *   crash-backup  SIGKILL `zinn backup` (VACUUM INTO) at a random moment. Then check what was left in
 *                 the backups directory, whether the source is intact, and whether the next backup works.
 *                 Core writes `<name>.sqlite.partial` and renames it when complete, so a kill may leave
 *                 `.partial` files (and their `-journal`), but a file under a final `.sqlite` name
 *                 must be a complete backup.
 */
import type { Options, ScenarioResult } from "../harness.ts";

import { existsSync, mkdirSync, copyFileSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "../../../packages/core/src/sqlite/bun.ts";
import { SqliteError } from "../../../packages/core/src/sqlite/database.ts";
import { Child, CORE_WORKER, cliCommand, countBy, createResult, formatBytes, RunDirectory, runToCompletion, sleep } from "../harness.ts";
import { createRandom, deriveSeed } from "../random.ts";
import { checkZinnInvariants, withDatabase, ZINN_TABLES } from "../zinn-checks.ts";

const CLI_TIMEOUT_MS = 60_000;
const SEED_TIMEOUT_MS = 180_000;
// Kill delays are spread over the calibrated duration of an uncontested command, plus a margin.
// Most of a command's time is Bun loading modules, and the database work comes last,
//  so the window starts part-way in.
const KILL_WINDOW_MARGIN = 1.1;
const INIT_KILL_WINDOW_START = 0.6;
const BACKUP_KILL_WINDOW_START = 0.5;
// Core writes a backup under this suffix and renames it when complete, so a leftover with it is expected after a kill.
const PARTIAL_BACKUP_SUFFIX = ".sqlite.partial";
const SQLITE_HEADER = "SQLite format 3\u0000";
// Byte 18 of the SQLite header is the file format write version: 2 means WAL. https://www.sqlite.org/fileformat.html
const WRITE_VERSION_OFFSET = 18;
const WAL_WRITE_VERSION = 2;
const INIT_PROJECT_KEY = "INIT";

function readHeader(path: string) {
  const buffer = Buffer.alloc(100);
  const descriptor = openSync(path, "r");

  try {
    const bytesRead = readSync(descriptor, buffer, 0, 100, 0);
    return bytesRead === 100 ? buffer : null;
  } finally {
    closeSync(descriptor);
  }
}

function errorCode(error: unknown) {
  return error instanceof SqliteError ? error.code : String((error as Error).message);
}

/** Describes what an interrupted first command left behind, before anything else opens it. */
function describeInitLeftovers(zinnDirectory: string, imageDirectory: string) {
  const settingsPath = join(zinnDirectory, "settings.json");
  const databasePath = join(zinnDirectory, "data", "zinn.sqlite");
  let settings = "no settings.json";

  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, "utf8");
    settings = content === "{}\n" ? "settings.json ok" : content.length === 0 ? "settings.json EMPTY" : "settings.json other";
  }

  if (!existsSync(databasePath)) {
    return `${settings}, no database`;
  }

  const size = statSync(databasePath).size;
  if (size === 0) {
    return `${settings}, empty database file`;
  }

  // Inspect a copy, so recovery here does not change what the next command sees.
  mkdirSync(imageDirectory, { recursive: true });
  const imagePath = join(imageDirectory, "zinn.sqlite");
  copyFileSync(databasePath, imagePath);
  if (existsSync(`${databasePath}-wal`)) {
    copyFileSync(`${databasePath}-wal`, `${imagePath}-wal`);
  }

  try {
    return withDatabase(imagePath, (db) => {
      const tables = new Set(
        db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
      );
      const present = ZINN_TABLES.filter((table) => tables.has(table)).length;
      const projects = tables.has("project")
        ? db.query<{ count: number }>("SELECT COUNT(*) AS count FROM project").get()!.count
        : 0;
      return `${settings}, ${present}/${ZINN_TABLES.length} tables, ${projects} project(s)`;
    });
  } catch (error) {
    return `${settings}, database unreadable (${errorCode(error)})`;
  }
}

export async function runCrashInit(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const result = createResult("crash-init");
  const random = createRandom(deriveSeed(options.seed, "crash-init"));
  const leftovers: Array<string> = [];
  const fail = (kind: string, detail: string, keptDirectory: string) => {
    result.failures.push({ scenario: result.name, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory });
  };

  const calibrationDirectory = run.create("crash-init-calibration");
  const calibration = await runToCompletion(cliCommand(["project", "create", INIT_PROJECT_KEY, "--json"]), calibrationDirectory, CLI_TIMEOUT_MS);
  run.remove(calibrationDirectory);
  if (calibration.exitCode !== 0) {
    fail("first command failed without a kill", calibration.stderr, calibrationDirectory);
    return result;
  }
  const windowStart = Math.round(calibration.durationMs * INIT_KILL_WINDOW_START);
  const windowEnd = Math.round(calibration.durationMs * KILL_WINDOW_MARGIN);
  result.notes.push(`uncontested first command took ${Math.round(calibration.durationMs)} ms; kills spread over ${windowStart}-${windowEnd} ms`);

  for (let iteration = 0; iteration < options.kills; iteration++) {
    run.checkDisk();
    const zinnDirectory = run.create("crash-init");
    let keepDirectory = false;

    try {
      const child = new Child(cliCommand(["project", "create", INIT_PROJECT_KEY, "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      await sleep(random.integer(windowStart, windowEnd));
      child.kill();
      await child.exited;
      result.iterations++;

      const imageDirectory = `${zinnDirectory}-image`;
      const leftover = describeInitLeftovers(zinnDirectory, imageDirectory);
      leftovers.push(child.wasKilled ? leftover : `finished before the kill: ${leftover}`);
      if (existsSync(imageDirectory)) {
        run.remove(imageDirectory);
      }

      // The next commands, as a user would run them after the interrupted one.
      const retry = await runToCompletion(cliCommand(["project", "create", INIT_PROJECT_KEY, "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      const retryAlreadyExists = retry.exitCode === 1 && retry.stderr.includes("already exists");
      if (retry.exitCode !== 0 && !retryAlreadyExists) {
        keepDirectory = true;
        fail("command after an interrupted first command failed", `iteration ${iteration} (${leftover}): ${retry.stderr.trim()}`, zinnDirectory);
        continue;
      }

      const created = await runToCompletion(cliCommand(["task", "create", INIT_PROJECT_KEY, "--title", "after crash", "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      if (created.exitCode !== 0) {
        keepDirectory = true;
        fail("task create after an interrupted first command failed", `iteration ${iteration} (${leftover}): ${created.stderr.trim()}`, zinnDirectory);
        continue;
      }

      const databasePath = join(zinnDirectory, "data", "zinn.sqlite");
      const header = readHeader(databasePath);
      const problems = withDatabase(databasePath, (db) => checkZinnInvariants(db));
      if (header == null || header.toString("latin1", 0, 16) !== SQLITE_HEADER) {
        problems.push("database header is not a SQLite header");
      } else if (header[WRITE_VERSION_OFFSET] !== WAL_WRITE_VERSION) {
        problems.push(`database is not in WAL mode (write version ${header[WRITE_VERSION_OFFSET]})`);
      }

      const settings = readFileSync(join(zinnDirectory, "settings.json"), "utf8");
      if (settings !== "{}\n") {
        problems.push(`settings.json holds ${JSON.stringify(settings)} after later commands, not "{}\\n"`);
      }

      if (problems.length > 0) {
        keepDirectory = true;
        fail("state after an interrupted first command", `iteration ${iteration} (${leftover}):\n    ${problems.join("\n    ")}`, zinnDirectory);
      }
    } finally {
      if (!keepDirectory && !options.keep) {
        run.remove(zinnDirectory);
      }
    }
  }

  result.notes.push(`left behind by the kill: ${countBy(leftovers).map(([state, count]) => `${count}x ${state}`).join("; ")}`);
  return result;
}

type BackupFileReport = { name: string; size: number; state: string };

/** Opens each file in the backups directory read-only and reports whether it is a usable snapshot. */
function inspectBackups(backupDirectory: string, sourceTaskCount: number): Array<BackupFileReport> {
  if (!existsSync(backupDirectory)) {
    return [];
  }

  return readdirSync(backupDirectory).map((name) => {
    const path = join(backupDirectory, name);
    const size = statSync(path).size;

    if (!name.endsWith(".sqlite")) {
      if (name.endsWith(`${PARTIAL_BACKUP_SUFFIX}-journal`)) {
        return { name, size, state: "unfinished .partial-journal" };
      }
      return { name, size, state: name.endsWith(PARTIAL_BACKUP_SUFFIX) ? "unfinished .partial" : "unexpected file" };
    }

    const header = size >= 100 ? readHeader(path) : null;
    if (header == null || header.toString("latin1", 0, 16) !== SQLITE_HEADER) {
      return { name, size, state: size === 0 ? "empty file" : "no valid SQLite header" };
    }

    try {
      const db = openDatabase(path, { readonly: true });
      try {
        const integrity = db.query<{ integrity_check: string }>("PRAGMA integrity_check").all().map((row) => row.integrity_check);
        if (integrity.length !== 1 || integrity[0] !== "ok") {
          return { name, size, state: `integrity_check failed: ${integrity[0]}` };
        }
        const taskCount = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count;
        return { name, size, state: taskCount === sourceTaskCount ? "complete" : `opens, but ${taskCount}/${sourceTaskCount} tasks` };
      } finally {
        db.close();
      }
    } catch (error) {
      return { name, size, state: `cannot be read: ${errorCode(error)}` };
    }
  });
}

export async function runCrashBackup(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const result = createResult("crash-backup");
  const random = createRandom(deriveSeed(options.seed, "crash-backup"));
  const zinnDirectory = run.create("crash-backup");
  const backupDirectory = join(zinnDirectory, "backups");
  const databasePath = join(zinnDirectory, "data", "zinn.sqlite");
  const leftovers: Array<string> = [];
  let partialAtFinalName = 0;
  let keepDirectory = false;
  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: result.name, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: zinnDirectory });
  };
  const clearBackups = () => {
    for (const name of existsSync(backupDirectory) ? readdirSync(backupDirectory) : []) {
      run.remove(join(backupDirectory, name));
    }
  };

  try {
    const seeded = await runToCompletion(
      ["bun", CORE_WORKER, "--mode", "seed", "--tasks", String(options.seedTasks), "--seed", String(deriveSeed(options.seed, "seed"))],
      zinnDirectory,
      SEED_TIMEOUT_MS,
    );
    if (seeded.exitCode !== 0) {
      fail("seeding failed", seeded.stderr);
      return result;
    }

    const sourceTaskCount = withDatabase(databasePath, (db) => db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count);
    const calibration = await runToCompletion(cliCommand(["backup", "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
    const calibrationFiles = inspectBackups(backupDirectory, sourceTaskCount);
    if (calibration.exitCode !== 0 || calibrationFiles.length !== 1 || calibrationFiles[0]!.state !== "complete") {
      fail("uncontested backup failed", `${calibration.stderr} ${JSON.stringify(calibrationFiles)}`);
      return result;
    }
    const backupSize = calibrationFiles[0]!.size;
    clearBackups();
    const windowStart = Math.round(calibration.durationMs * BACKUP_KILL_WINDOW_START);
    const windowEnd = Math.round(calibration.durationMs * KILL_WINDOW_MARGIN);
    result.notes.push(
      `source: ${sourceTaskCount} tasks, backup ${formatBytes(backupSize)}; uncontested backup took ${Math.round(calibration.durationMs)} ms; kills spread over ${windowStart}-${windowEnd} ms`,
    );

    for (let iteration = 0; iteration < options.kills; iteration++) {
      run.checkDisk();
      const child = new Child(cliCommand(["backup", "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      await sleep(random.integer(windowStart, windowEnd));
      child.kill();
      await child.exited;
      result.iterations++;

      const files = inspectBackups(backupDirectory, sourceTaskCount);
      const leftover = files.length === 0 ? "nothing" : files.map((file) => file.state).join(" + ");
      leftovers.push(child.wasKilled ? leftover : `finished before the kill: ${leftover}`);
      partialAtFinalName += files.filter((file) => file.name.endsWith(".sqlite") && file.state !== "complete").length;

      // The source must be untouched, and the next backup must work.
      const sourceProblems = withDatabase(databasePath, (db) => {
        const problems = checkZinnInvariants(db);
        const taskCount = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count;
        if (taskCount !== sourceTaskCount) {
          problems.push(`source holds ${taskCount} tasks, expected ${sourceTaskCount}`);
        }
        return problems;
      });
      if (sourceProblems.length > 0) {
        fail("source damaged by an interrupted backup", `iteration ${iteration}: ${sourceProblems.join("; ")}`);
        break;
      }

      const before = new Set(files.map((file) => file.name));
      const next = await runToCompletion(cliCommand(["backup", "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      const nextFile = inspectBackups(backupDirectory, sourceTaskCount).find((file) => !before.has(file.name));
      if (next.exitCode !== 0 || nextFile?.state !== "complete") {
        fail("backup after an interrupted backup failed", `iteration ${iteration}: exit ${next.exitCode} ${next.stderr.trim()} ${JSON.stringify(nextFile)}`);
        break;
      }

      clearBackups();
    }
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(zinnDirectory);
    }
  }

  result.notes.push(`left in backups/ by the kill: ${countBy(leftovers).map(([state, count]) => `${count}x ${state}`).join("; ")}`);
  if (partialAtFinalName > 0) {
    result.failures.push({
      scenario: result.name,
      kind: "incomplete backup under the final backup name",
      detail: `${partialAtFinalName} of ${result.iterations} interrupted backups left a file named like a finished backup (<timestamp>Z-cli-<version>-<suffix>.sqlite) that is not a complete snapshot\n    reproduce: ${reproduce}`,
      keptDirectory: null,
    });
  }
  return result;
}
