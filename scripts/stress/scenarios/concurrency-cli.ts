/**
 * Scenario concurrency-cli: the real user path under contention.
 * Several lanes each run a sequence of `bun packages/cli/index.ts ... --json` commands at the same time
 *  against one ZINN_DIR: writers create, edit, move and comment, readers list, view and search, and
 *  now and then a lane takes a backup. Every command's outcome is recorded as its user would see it.
 *
 * Checks: acknowledged writes are present with their last acknowledged values, no duplicate task
 *  numbers, Zinn's invariants on the database and on every backup taken during the run, errors that
 *  reached a user, and command latency.
 *
 * Two races from first use run alongside: many first commands on a new ZINN_DIR at once, and many
 *  `project create` commands for the same key (packages/core/NOTES.md asks for this one).
 */
import type { Options, ScenarioResult } from "../harness.ts";

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { cliCommand, countBy, createResult, describeLatencies, RunDirectory, runToCompletion } from "../harness.ts";
import { createRandom, deriveSeed, type Random } from "../random.ts";
import { checkZinnInvariants, withDatabase } from "../zinn-checks.ts";

const SCENARIO = "concurrency-cli";
const PROJECT_KEY = "W";
const SHARED_TASK_KEY = `${PROJECT_KEY}-1`;
const COLUMNS = ["Backlog", "TODO", "In Progress", "Review", "Done"];
const CLI_TIMEOUT_MS = 120_000;
// The first-use races start this many commands at once for every concurrent lane.
const RACE_PROCESSES_PER_LANE = 2;
const RAW_SQLITE_MESSAGE = /constraint failed|database is locked|disk I\/O|SQLITE_/i;

type CommandRecord = {
  lane: number;
  kind: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  output: Record<string, unknown> | null;
};

type LaneState = { ownTasks: Array<string> };

function errorMessage(record: { stderr: string }) {
  try {
    return (JSON.parse(record.stderr) as { error: { message: string } }).error.message;
  } catch {
    return record.stderr.trim().slice(0, 300);
  }
}

function chooseCommand(random: Random, lane: number, state: LaneState, step: number): { kind: string; args: Array<string> } {
  const marker = `L${lane}s${step}`;
  const hasOwnTasks = state.ownTasks.length > 0;
  const kind = random.weighted({
    create: 25,
    edit: hasOwnTasks ? 15 : 0,
    commentShared: 12,
    commentOwn: hasOwnTasks ? 8 : 0,
    move: hasOwnTasks ? 10 : 0,
    list: 10,
    view: 10,
    search: 8,
    backup: 2,
  });

  switch (kind) {
    case "create":
      return { kind, args: ["task", "create", PROJECT_KEY, "--title", `${marker} created`, "--description", random.text(120)] };
    case "edit":
      return { kind, args: ["task", "edit", random.pick(state.ownTasks), "--title", `${marker} edited`] };
    case "commentShared":
      return { kind, args: ["task", "comment", "create", SHARED_TASK_KEY, "--text", `${marker} comment`] };
    case "commentOwn":
      return { kind, args: ["task", "comment", "create", random.pick(state.ownTasks), "--text", `${marker} comment`] };
    case "move":
      return { kind, args: ["task", "move", random.pick(state.ownTasks), random.pick(COLUMNS)] };
    case "list":
      return { kind, args: ["task", "list", PROJECT_KEY] };
    case "view":
      return { kind, args: ["task", "view", SHARED_TASK_KEY] };
    case "search":
      return { kind, args: ["task", "search", `L${random.integer(0, 9)}s`] };
    default:
      return { kind, args: ["backup"] };
  }
}

async function runLane(lane: number, options: Options, zinnDirectory: string, records: Array<CommandRecord>) {
  const random = createRandom(deriveSeed(options.seed, `${SCENARIO}-lane-${lane}`));
  const state: LaneState = { ownTasks: [] };

  for (let step = 0; step < options.commands; step++) {
    const { kind, args } = chooseCommand(random, lane, state, step);
    const outcome = await runToCompletion(cliCommand([...args, "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
    let output: Record<string, unknown> | null = null;

    if (outcome.exitCode === 0) {
      try {
        output = JSON.parse(outcome.stdout) as Record<string, unknown>;
      } catch {
        output = null;
      }
    }

    records.push({ lane, kind, durationMs: outcome.durationMs, exitCode: outcome.exitCode, stderr: outcome.stderr, output });

    if (kind === "create" && output != null) {
      state.ownTasks.push(String(output.key));
    }
  }
}

/** Compares acknowledged CLI writes with the database. */
function checkAcknowledged(records: Array<CommandRecord>, zinnDirectory: string) {
  const problems: Array<string> = [];
  const succeeded = records.filter((record) => record.exitCode === 0 && record.output != null);
  const expectedTitles = new Map<string, string>();
  const expectedColumns = new Map<string, string>();
  const createdKeys: Array<string> = [];
  const comments = new Map<string, string>();

  // Records are in completion order. Each lane only edits and moves its own tasks, sequentially,
  //  so for a given task the later record is the later write.
  for (const record of succeeded) {
    const output = record.output!;
    if (record.kind === "create") {
      createdKeys.push(String(output.key));
      expectedTitles.set(String(output.key), String(output.title));
    } else if (record.kind === "edit") {
      expectedTitles.set(String(output.key), String(output.title));
    } else if (record.kind === "move") {
      expectedColumns.set(String(output.key), String(output.column));
    } else if (record.kind === "commentShared" || record.kind === "commentOwn") {
      comments.set(String(output.key), String(output.text));
    }
  }

  const duplicateKeys = countBy(createdKeys).filter(([, count]) => count > 1);
  for (const [key, count] of duplicateKeys) {
    problems.push(`task key ${key} was returned by ${count} successful creates`);
  }

  const databaseProblems = withDatabase(join(zinnDirectory, "data", "zinn.sqlite"), (db) => {
    const found: Array<string> = [];
    const taskByKey = db.query<{ title: string; column_name: string }, [string, number]>(`SELECT task.title, project_column.name AS column_name
      FROM task JOIN project ON project.id = task.project_id JOIN project_column ON project_column.id = task.column_id
      WHERE project.key = ? AND task.number = ?`);

    for (const [key, title] of expectedTitles) {
      const row = taskByKey.get(PROJECT_KEY, Number(key.split("-")[1]));
      if (row == null) {
        found.push(`acknowledged task ${key} is missing`);
      } else if (row.title !== title) {
        found.push(`task ${key}: title ${JSON.stringify(row.title)}, last acknowledged ${JSON.stringify(title)}`);
      }
    }

    for (const [key, column] of expectedColumns) {
      const row = taskByKey.get(PROJECT_KEY, Number(key.split("-")[1]));
      if (row != null && row.column_name !== column) {
        found.push(`task ${key}: column ${row.column_name}, last acknowledged ${column}`);
      }
    }

    const commentByKey = db.query<{ text: string }, [string, number, number]>(`SELECT comment.text FROM comment
      JOIN task ON task.id = comment.task_id JOIN project ON project.id = task.project_id
      WHERE project.key = ? AND task.number = ? AND comment.number = ?`);
    for (const [key, text] of comments) {
      const [taskKey, commentNumber] = key.split("#");
      const row = commentByKey.get(PROJECT_KEY, Number(taskKey!.split("-")[1]), Number(commentNumber));
      if (row?.text !== text) {
        found.push(`acknowledged comment ${key} is ${row == null ? "missing" : `different: ${JSON.stringify(row.text)}`}`);
      }
    }

    return [...found, ...checkZinnInvariants(db)];
  });

  return [...problems, ...databaseProblems];
}

/** Every backup taken during the run must be a consistent snapshot: complete and passing the same invariants. */
function checkBackups(zinnDirectory: string) {
  const backupDirectory = join(zinnDirectory, "backups");
  const problems: Array<string> = [];
  const names = existsSync(backupDirectory) ? readdirSync(backupDirectory) : [];

  for (const name of names) {
    const backupProblems = withDatabase(join(backupDirectory, name), (db) => checkZinnInvariants(db));
    for (const problem of backupProblems) {
      problems.push(`backup ${name}: ${problem}`);
    }
  }

  return { problems, count: names.length };
}

async function runRace(
  label: string,
  run: RunDirectory,
  zinnDirectory: string,
  processCount: number,
  argsFor: (index: number) => Array<string>,
) {
  run.assertIsolated(zinnDirectory);
  const outcomes = await Promise.all(
    Array.from({ length: processCount }, (_, index) => runToCompletion(cliCommand([...argsFor(index), "--json"]), zinnDirectory, CLI_TIMEOUT_MS)),
  );
  const failures = outcomes.filter((outcome) => outcome.exitCode !== 0);
  const messages = countBy(failures.map((outcome) => errorMessage(outcome)));

  return { label, outcomes, failures, messages };
}

export async function runConcurrencyCli(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const result = createResult(SCENARIO);
  const zinnDirectory = run.create(SCENARIO);
  const keptDirectories = new Set<string>();
  const fail = (kind: string, detail: string, directory: string) => {
    keptDirectories.add(directory);
    result.failures.push({ scenario: SCENARIO, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: directory });
  };
  const raceDirectories: Array<string> = [];

  try {
    for (const args of [
      ["project", "create", PROJECT_KEY],
      ["task", "create", PROJECT_KEY, "--title", "shared"],
    ]) {
      const setup = await runToCompletion(cliCommand([...args, "--json"]), zinnDirectory, CLI_TIMEOUT_MS);
      if (setup.exitCode !== 0) {
        fail("setup failed", setup.stderr, zinnDirectory);
        return result;
      }
    }

    const records: Array<CommandRecord> = [];
    const began = performance.now();
    await Promise.all(Array.from({ length: options.processes }, (_, lane) => runLane(lane, options, zinnDirectory, records)));
    const elapsedSeconds = (performance.now() - began) / 1000;
    result.iterations = records.length;
    run.checkDisk();

    const userErrors = records.filter((record) => record.exitCode !== 0);
    if (userErrors.length > 0) {
      const messages = countBy(userErrors.map((record) => `${record.kind}: ${errorMessage(record)}`));
      fail("errors reached the user", messages.map(([message, count]) => `${count}x ${message}`).join("\n    "), zinnDirectory);
    }

    const problems = checkAcknowledged(records, zinnDirectory);
    if (problems.length > 0) {
      fail("acknowledged writes or invariants violated", problems.slice(0, 10).join("\n    "), zinnDirectory);
    }

    const backups = checkBackups(zinnDirectory);
    if (backups.problems.length > 0) {
      fail("backup taken under contention is inconsistent", backups.problems.slice(0, 10).join("\n    "), zinnDirectory);
    }

    const writes = records.filter((record) => ["create", "edit", "move", "commentShared", "commentOwn"].includes(record.kind));
    const reads = records.filter((record) => ["list", "view", "search"].includes(record.kind));
    result.notes.push(
      `${options.processes} lanes, ${records.length} commands in ${elapsedSeconds.toFixed(1)} s (${writes.length} writes, ${reads.length} reads, ${backups.count} backups checked)`,
    );
    result.notes.push(`write latency ${describeLatencies(writes.map((record) => record.durationMs))}`);
    result.notes.push(`read latency ${describeLatencies(reads.map((record) => record.durationMs))}`);

    // First use: every process starts on a ZINN_DIR that does not exist yet.
    const raceSize = options.processes * RACE_PROCESSES_PER_LANE;
    const freshDirectory = join(run.root, `${SCENARIO}-fresh-init`);
    raceDirectories.push(freshDirectory);
    const freshRace = await runRace("fresh-init", run, freshDirectory, raceSize, (index) => ["project", "create", `P${index}`]);
    const freshProblems = existsSync(join(freshDirectory, "data", "zinn.sqlite"))
      ? withDatabase(join(freshDirectory, "data", "zinn.sqlite"), (db) => {
          const found = checkZinnInvariants(db);
          const projects = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM project").get()!.count;
          const acknowledged = freshRace.outcomes.length - freshRace.failures.length;
          if (projects !== acknowledged) {
            found.push(`${acknowledged} project creates succeeded, ${projects} projects exist`);
          }
          return found;
        })
      : ["no database after the race"];
    result.notes.push(`fresh-init race: ${raceSize} first commands at once, ${freshRace.failures.length} failed`);
    if (freshRace.failures.length > 0) {
      fail("errors reached the user on first use", freshRace.messages.map(([message, count]) => `${count}x ${message}`).join("\n    "), freshDirectory);
    }
    if (freshProblems.length > 0) {
      fail("fresh-init race left an inconsistent database", freshProblems.join("\n    "), freshDirectory);
    }

    // The same project key from many processes: one must win, the rest must get the friendly error.
    const duplicateDirectory = run.create(`${SCENARIO}-same-key`);
    raceDirectories.push(duplicateDirectory);
    await runToCompletion(cliCommand(["project", "list", "--json"]), duplicateDirectory, CLI_TIMEOUT_MS);
    const keyRace = await runRace("same-key", run, duplicateDirectory, raceSize, () => ["project", "create", "DUP"]);
    const winners = keyRace.outcomes.length - keyRace.failures.length;
    const rawErrors = keyRace.failures.filter((outcome) => RAW_SQLITE_MESSAGE.test(errorMessage(outcome)));
    result.notes.push(
      `same-key race: ${raceSize} creates of one key, ${winners} succeeded; messages: ${keyRace.messages.map(([message, count]) => `${count}x ${message}`).join("; ")}`,
    );
    if (winners !== 1) {
      fail("same-key race", `${winners} creates of one project key succeeded`, duplicateDirectory);
    }
    if (rawErrors.length > 0) {
      fail(
        "raw SQLite error reached the user",
        `${rawErrors.length} of ${raceSize} same-key project creates printed a raw SQLite message instead of "already exists": ${errorMessage(rawErrors[0]!)}`,
        duplicateDirectory,
      );
    }
  } finally {
    if (!options.keep) {
      for (const directory of [zinnDirectory, ...raceDirectories]) {
        if (!keptDirectories.has(directory) && existsSync(directory)) {
          run.remove(directory);
        }
      }
    }
  }

  return result;
}
