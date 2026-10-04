/**
 * Scenario crash-core: SIGKILL a Bun process while it runs a seeded mix of real core operations.
 *
 * The worker appends "begin" before each operation and "ack" (with snapshots of what it touched)
 *  after the operation's transaction returned. After each kill the parent checks a copy of the
 *  database files as the kill left them (main file and WAL, without the -shm index, so SQLite has to
 *  recover from the WAL alone):
 *   - every acknowledged operation is present, and nothing else changed,
 *   - the one operation in flight at the kill either fully committed or left no trace,
 *   - integrity, foreign keys and Zinn's own invariants (zinn-checks.ts).
 * The next worker then reopens the original files through getDb(), the real startup path.
 */
import type { Database } from "../../../packages/core/src/sqlite/database.ts";
import type { Options, ScenarioResult } from "../harness.ts";
import type { LabelSnapshot, ProjectSnapshot, TaskSnapshot } from "../zinn-checks.ts";

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Child, CORE_WORKER, createResult, RunDirectory, sleep } from "../harness.ts";
import { createRandom, deriveSeed } from "../random.ts";
import { completeLines, CRASH_PROJECT_KEY, type Expectation } from "../workload.ts";
import {
  checkZinnInvariants,
  maxActivityRowid,
  sameSnapshot,
  snapshotLabel,
  snapshotProject,
  snapshotTask,
  withDatabase,
} from "../zinn-checks.ts";

const SCENARIO = "crash-core";
const WORKER_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
// Some kills land during startup: module loading, getDb() and WAL recovery of the previous crash.
const EARLY_KILL_CHANCE = 0.15;
const STARTUP_WINDOW_MS = 120;
const MAX_KILL_DELAY_MS = 250;

export type BeginEntry = {
  t: "begin";
  seq: number;
  op: string;
  marker: string;
  touchTasks: Array<string>;
  touchLabels: Array<string>;
  expect: Expectation;
};
type AckEntry = {
  t: "ack";
  seq: number;
  tasks: Record<string, TaskSnapshot | null>;
  labels: Record<string, LabelSnapshot | null>;
  project: ProjectSnapshot | null;
  activityRowid: number;
};
type FailEntry = { t: "fail"; seq: number; code: string | null; error: string };
export type LogEntry = BeginEntry | AckEntry | FailEntry;

/** What the database must contain: the state after the last acknowledged operation. */
export class Model {
  tasks = new Map<string, TaskSnapshot | null>();
  labels = new Map<string, LabelSnapshot | null>();
  project: ProjectSnapshot | null = null;
  activityRowid = 0;
  acknowledged = 0;

  apply(ack: AckEntry) {
    for (const [id, snapshot] of Object.entries(ack.tasks)) {
      this.tasks.set(id, snapshot);
    }
    for (const [id, snapshot] of Object.entries(ack.labels)) {
      this.labels.set(id, snapshot);
    }
    this.project = ack.project;
    this.activityRowid = ack.activityRowid;
    this.acknowledged++;
  }

  /** After a check, takes the database's word for whatever the in-flight operation may have changed. */
  rebaseline(db: Database) {
    for (const row of db.query<{ id: string }>("SELECT id FROM task").all()) {
      if (!this.tasks.has(row.id) || this.tasks.get(row.id) == null) {
        this.tasks.set(row.id, snapshotTask(db, row.id));
      }
    }
    for (const id of this.tasks.keys()) {
      this.tasks.set(id, snapshotTask(db, id));
    }
    for (const row of db.query<{ id: string }>("SELECT id FROM label").all()) {
      this.labels.set(row.id, snapshotLabel(db, row.id));
    }
    for (const id of this.labels.keys()) {
      this.labels.set(id, snapshotLabel(db, id));
    }
    this.project = snapshotProject(db, CRASH_PROJECT_KEY);
    this.activityRowid = maxActivityRowid(db);
  }
}

export function readLog(path: string) {
  if (!existsSync(path)) {
    return [];
  }

  return completeLines(readFileSync(path, "utf8")).map((line) => JSON.parse(line) as LogEntry);
}

function expectationHolds(db: Database, expectation: Expectation) {
  switch (expectation.kind) {
    case "none":
      return true;
    case "task-title": {
      if (expectation.taskId == null) {
        return db.query<{ id: string }, [string]>("SELECT id FROM task WHERE title = ?").get(expectation.title) != null;
      }
      return snapshotTask(db, expectation.taskId)?.title === expectation.title;
    }
    case "task-column":
      return snapshotTask(db, expectation.taskId)?.column === expectation.column;
    case "task-archived":
      return snapshotTask(db, expectation.taskId)?.archived === expectation.archived;
    case "task-deleted":
      return snapshotTask(db, expectation.taskId) == null;
    case "comment-text":
      return snapshotTask(db, expectation.taskId)?.comments.some(([, text]) => text === expectation.text) === true;
    case "comment-deleted": {
      const snapshot = snapshotTask(db, expectation.taskId);
      return snapshot == null || !snapshot.comments.some(([number]) => number === expectation.number);
    }
    case "task-label":
      return snapshotTask(db, expectation.taskId)?.labels.includes(expectation.labelId) === expectation.attached;
    case "relation": {
      const sourceId = expectation.relation.slice(expectation.relation.indexOf(":") + 1, expectation.relation.indexOf(">"));
      const relations = snapshotTask(db, sourceId)?.relations ?? [];
      return relations.includes(expectation.relation) === expectation.exists;
    }
    case "label-name":
      return db.query<{ id: string }, [string]>("SELECT id FROM label WHERE name = ?").get(expectation.name) != null;
    case "label-deleted":
      return snapshotLabel(db, expectation.labelId) == null;
    case "project-description":
      return snapshotProject(db, CRASH_PROJECT_KEY)?.description === expectation.description;
  }
}

type KillOutcome = "committed" | "rolled back" | "between operations";

/** Compares the database with the model and the in-flight operation. Returns problems and what the kill interrupted. */
export function compareWithModel(db: Database, model: Model, inFlight: BeginEntry | null) {
  const problems: Array<string> = [];
  const newActivity = db
    .query<{ entity_type: string; entity_id: string; action: string }, [number]>(
      "SELECT entity_type, entity_id, action FROM activity WHERE rowid > ? ORDER BY rowid",
    )
    .all(model.activityRowid);
  const didCommit = newActivity.length > 0;
  let outcome: KillOutcome = "between operations";

  if (inFlight == null && didCommit) {
    problems.push(`${newActivity.length} activity row(s) after the last acknowledged operation, with none in flight`);
  }
  if (inFlight != null) {
    outcome = didCommit ? "committed" : "rolled back";
  }

  // Only a committed in-flight operation may have changed anything beyond the model.
  const uncertainTasks = new Set(didCommit && inFlight != null ? inFlight.touchTasks : []);
  const uncertainLabels = new Set(didCommit && inFlight != null ? inFlight.touchLabels : []);

  for (const [id, expected] of model.tasks) {
    if (uncertainTasks.has(id)) {
      continue;
    }
    const actual = snapshotTask(db, id);
    if (!sameSnapshot(actual, expected)) {
      problems.push(`task ${id} differs from its last acknowledged state:\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
    }
  }

  for (const [id, expected] of model.labels) {
    if (uncertainLabels.has(id)) {
      continue;
    }
    const actual = snapshotLabel(db, id);
    if (!sameSnapshot(actual, expected)) {
      problems.push(`label ${id} differs from its last acknowledged state: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    }
  }

  const project = snapshotProject(db, CRASH_PROJECT_KEY);
  const projectMayChange = didCommit && (inFlight?.op === "create" || inFlight?.op === "projectEdit");
  if (!projectMayChange && !sameSnapshot(project, model.project)) {
    problems.push(`project differs from its last acknowledged state: expected ${JSON.stringify(model.project)}, actual ${JSON.stringify(project)}`);
  }

  const newTasks = db
    .query<{ id: string; title: string }>("SELECT id, title FROM task")
    .all()
    .filter((row) => !model.tasks.has(row.id));
  const isTaskCreateInFlight = didCommit && inFlight?.op === "create";
  if (newTasks.length > (isTaskCreateInFlight ? 1 : 0)) {
    problems.push(`unexpected task(s) not created by any acknowledged operation: ${newTasks.map((row) => row.title).join(", ")}`);
  }

  const newLabels = db
    .query<{ id: string; name: string }>("SELECT id, name FROM label")
    .all()
    .filter((row) => !model.labels.has(row.id));
  const isLabelCreateInFlight = didCommit && inFlight?.op === "labelCreate";
  if (newLabels.length > (isLabelCreateInFlight ? 1 : 0)) {
    problems.push(`unexpected label(s): ${newLabels.map((row) => row.name).join(", ")}`);
  }

  if (didCommit && inFlight != null) {
    const allowedEntities = new Set([
      ...inFlight.touchTasks,
      ...inFlight.touchLabels,
      ...newTasks.map((row) => row.id),
      ...newLabels.map((row) => row.id),
    ]);
    const projectId = db.query<{ id: string }, [string]>("SELECT id FROM project WHERE key = ?").get(CRASH_PROJECT_KEY)?.id;
    if (projectId != null) {
      allowedEntities.add(projectId);
    }

    for (const row of newActivity) {
      if (!allowedEntities.has(row.entity_id)) {
        problems.push(`in-flight ${inFlight.op} wrote activity for an entity it does not touch: ${JSON.stringify(row)}`);
      }
    }

    // Committed means the whole operation landed, not just its activity row.
    if (!expectationHolds(db, inFlight.expect)) {
      problems.push(`in-flight ${inFlight.op} (${inFlight.marker}) committed activity but not its change: ${JSON.stringify(inFlight.expect)}`);
    }
  }

  return { problems, outcome };
}

/** Copies the main file and WAL as the kill left them, leaving out -shm so recovery rebuilds it. */
export function copyCrashImage(zinnDirectory: string, destination: string) {
  const source = join(zinnDirectory, "data", "zinn.sqlite");
  mkdirSync(destination, { recursive: true });
  const target = join(destination, "zinn.sqlite");

  copyFileSync(source, target);
  if (existsSync(`${source}-wal`)) {
    copyFileSync(`${source}-wal`, `${target}-wal`);
  }

  return target;
}

export async function runCrashCore(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const result = createResult(SCENARIO);
  const zinnDirectory = run.create(SCENARIO);
  const random = createRandom(deriveSeed(options.seed, SCENARIO));
  const model = new Model();
  const outcomes: Record<KillOutcome | "before ready", number> = {
    committed: 0,
    "rolled back": 0,
    "between operations": 0,
    "before ready": 0,
  };
  const sqliteErrors: Array<string> = [];
  let keepDirectory = false;

  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: SCENARIO, kind, detail, keptDirectory: zinnDirectory });
  };

  try {
    for (let iteration = 0; iteration < options.kills; iteration++) {
      run.checkDisk();
      const logPath = join(zinnDirectory, `acks-${iteration}.log`);
      const command = [
        "bun", CORE_WORKER, "--mode", "crash", "--run", String(iteration),
        "--seed", String(deriveSeed(options.seed, `${SCENARIO}-${iteration}`)), "--log", logPath,
      ];
      run.assertIsolated(zinnDirectory);
      const child = new Child(command, zinnDirectory, WORKER_TIMEOUT_MS);
      // The first run creates the project, so it is never killed before it is ready.
      const killsEarly = iteration > 0 && random.chance(EARLY_KILL_CHANCE);

      if (killsEarly) {
        await sleep(random.integer(0, STARTUP_WINDOW_MS));
      } else {
        const ready = await child.waitForLine((line) => line === "ready", READY_TIMEOUT_MS);
        if (ready == null) {
          child.kill();
          await child.exited;
          fail("worker failed to start after a crash", `run ${iteration}: exit ${child.process.exitCode}, stderr: ${child.stderr.trim().slice(0, 2000)}`);
          break;
        }
        await sleep(random.integer(0, MAX_KILL_DELAY_MS));
      }

      child.kill();
      await child.exited;
      result.iterations++;

      if (!child.wasKilled) {
        fail("worker exited before the kill", `run ${iteration}: exit ${child.process.exitCode}, stderr: ${child.stderr.trim().slice(0, 2000)}`);
        break;
      }

      let inFlight: BeginEntry | null = null;
      for (const entry of readLog(logPath)) {
        if (entry.t === "begin") {
          inFlight = entry;
        } else if (entry.t === "ack") {
          model.apply(entry);
          inFlight = null;
        } else {
          inFlight = null;
          if (entry.code != null) {
            sqliteErrors.push(`${entry.code}: ${entry.error}`);
          }
        }
      }

      if (!existsSync(join(zinnDirectory, "data", "zinn.sqlite"))) {
        // Killed before the very first open created the file: nothing to check yet.
        outcomes["before ready"]++;
        continue;
      }

      const imageDirectory = join(zinnDirectory, `image-${iteration}`);
      const imagePath = copyCrashImage(zinnDirectory, imageDirectory);
      const { problems, outcome } = withDatabase(imagePath, (db) => {
        const comparison = compareWithModel(db, model, inFlight);
        const invariantProblems = checkZinnInvariants(db);
        model.rebaseline(db);
        return { problems: [...comparison.problems, ...invariantProblems], outcome: comparison.outcome };
      });

      if (killsEarly && outcome === "between operations") {
        outcomes["before ready"]++;
      } else {
        outcomes[outcome]++;
      }

      if (problems.length > 0) {
        fail(
          "crash image violates acknowledged state or invariants",
          `run ${iteration} (kill ${killsEarly ? "during startup" : "after ready"}, in flight: ${inFlight?.op ?? "none"}; crash image kept at ${imageDirectory}):\n    ${problems.slice(0, 10).join("\n    ")}`,
        );
        break;
      }

      run.remove(imageDirectory);
    }

    // Finally open the live files the way the next command would, with their -shm, and check again.
    if (result.failures.length === 0) {
      const finalProblems = withDatabase(join(zinnDirectory, "data", "zinn.sqlite"), (db) => [
        ...compareWithModel(db, model, null).problems,
        ...checkZinnInvariants(db),
      ]);
      if (finalProblems.length > 0) {
        fail("live database differs after the last kill", finalProblems.slice(0, 10).join("\n    "));
      }
    }
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(zinnDirectory);
    }
  }

  result.notes.push(`${model.acknowledged} acknowledged operations checked across ${result.iterations} kills`);
  result.notes.push(
    `kill landed: ${outcomes.committed} with the in-flight operation committed, ${outcomes["rolled back"]} with it rolled back, ${outcomes["between operations"]} between operations, ${outcomes["before ready"]} during startup`,
  );
  if (sqliteErrors.length > 0) {
    result.notes.push(`SQLite errors inside the worker: ${sqliteErrors.slice(0, 5).join("; ")}`);
  }
  for (const failure of result.failures) {
    failure.detail += `\n    reproduce: ${reproduce}`;
  }

  return result;
}
