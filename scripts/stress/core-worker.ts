/**
 * A child process that runs real core operations against $ZINN_DIR until it is killed.
 * Bun only: core imports randomUUIDv7 from "bun".
 *
 * Modes:
 *   crash    one writer runs a seeded mix of operations and records each in an acknowledgment log
 *            (scenario crash-core). The log line is appended only after the operation's transaction
 *            committed and returned, so every acknowledged operation must survive a SIGKILL.
 *   contend  one of several concurrent writers on a shared project (scenario concurrency-kill).
 *            Prints LOCK <seq> right after BEGIN IMMEDIATE succeeds, so the parent can kill it
 *            while it holds the write lock.
 *   seed     fills a project with tasks, then exits (scenario crash-backup).
 */
import type { Actor } from "../../packages/core/index.ts";
import type { Database } from "../../packages/core/src/sqlite/database.ts";

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { comment, label, project, relation, task } from "../../packages/core/index.ts";
import { getDb } from "../../packages/core/src/db.ts";
import { SqliteError } from "../../packages/core/src/sqlite/database.ts";

import { createRandom, type Random } from "./random.ts";
import { CONTEND_PROJECT_KEY, CRASH_PROJECT_KEY, SEED_PROJECT_KEY, type Expectation } from "./workload.ts";
import { maxActivityRowid, snapshotLabel, snapshotProject, snapshotTask } from "./zinn-checks.ts";

const actor: Actor = { name: "stress-worker", email: null, kind: "agent" };

// Bounds keep the crash database small however long the run is.
const MAX_ACTIVE_TASKS = 60;
const MAX_LABELS = 6;
const MAX_COMMENTS_PER_TASK = 12;
const LABEL_COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"] as const;
const DIRECTIONS = ["top", "up", "down", "bottom"] as const;
const RELATION_TYPES = ["related", "dependency", "duplicate", "subtask"] as const;

// How long a contend worker keeps the write lock after announcing it, so a kill lands inside the transaction.
const LOCK_HOLD_MS = 4;
// A safety stop in case the parent never kills this worker.
const MAX_OPERATIONS_PER_PROCESS = 20_000;

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    seed: { type: "string" },
    run: { type: "string" },
    log: { type: "string" },
    lane: { type: "string" },
    tasks: { type: "string" },
  },
  strict: true,
});

const mode = values.mode;
const random = createRandom(Number(values.seed ?? 1));

function appendLog(entry: unknown) {
  appendFileSync(values.log!, JSON.stringify(entry) + "\n");
}

function sqliteCode(error: unknown) {
  return error instanceof SqliteError ? error.code : null;
}

type TaskRow = { id: string; number: number; archived_at: number | null; column_id: string };

function readTasks(db: Database, projectId: string) {
  return db
    .query<TaskRow, [string]>("SELECT id, number, archived_at, column_id FROM task WHERE project_id = ? ORDER BY number")
    .all(projectId);
}

type PlannedOperation = {
  name: string;
  touchTasks: Array<string>;
  touchLabels: Array<string>;
  expect: Expectation;
  run: () => unknown;
  /** Ids created by the operation, read from its result after it returns. */
  createdTaskId?: (result: unknown) => string;
  createdLabelId?: (result: unknown) => string;
};

/** Picks the next operation from the current database state. Returns null when the pick does not apply. */
function planCrashOperation(db: Database, marker: string, rng: Random): PlannedOperation | null {
  const projectMatch = project.getByKey(CRASH_PROJECT_KEY)!;
  const tasks = readTasks(db, projectMatch.id);
  const activeTasks = tasks.filter((candidate) => candidate.archived_at == null);
  const archivedTasks = tasks.filter((candidate) => candidate.archived_at != null);
  const labels = db.query<{ id: string; name: string }>("SELECT id, name FROM label ORDER BY name").all();
  const columns = db
    .query<{ id: string; name: string }, [string]>("SELECT id, name FROM project_column WHERE project_id = ? ORDER BY column_order")
    .all(projectMatch.id);
  const keyOf = (candidate: { number: number }) => `${CRASH_PROJECT_KEY}-${candidate.number}`;
  const isCrowded = activeTasks.length > MAX_ACTIVE_TASKS;

  const operationName = rng.weighted({
    create: isCrowded ? 2 : 20,
    edit: 14,
    move: 10,
    order: 5,
    archive: 5,
    unarchive: 4,
    delete: isCrowded ? 30 : 6,
    commentCreate: 12,
    commentEdit: 5,
    commentDelete: 4,
    labelAdd: 5,
    labelRemove: 4,
    relationCreate: 6,
    relationDelete: 4,
    labelCreate: labels.length < MAX_LABELS ? 3 : 0,
    labelDelete: labels.length > 2 ? 1 : 0,
    projectEdit: 2,
  });

  const pickTask = (candidates: Array<TaskRow>) => (candidates.length === 0 ? null : rng.pick(candidates));

  switch (operationName) {
    case "create": {
      const title = `${marker} created`;
      const labelNames = labels.length > 0 && rng.chance(0.3) ? [rng.pick(labels).name] : [];
      return {
        name: operationName,
        touchTasks: [],
        touchLabels: [],
        expect: { kind: "task-title", taskId: null, title },
        run: () =>
          task.create(
            { project_id: projectMatch.id, title, description: rng.text(rng.integer(0, 400)), labelNames },
            actor,
          ),
        createdTaskId: (result) => (result as { id: string }).id,
      };
    }
    case "edit": {
      const target = pickTask(tasks);
      if (target == null) {
        return null;
      }
      const title = `${marker} edited`;
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "task-title", taskId: target.id, title },
        run: () => task.edit({ taskKey: keyOf(target), title, description: rng.text(rng.integer(0, 400)) }, actor),
      };
    }
    case "move": {
      const target = pickTask(activeTasks);
      if (target == null) {
        return null;
      }
      const destination = rng.pick(columns.filter((column) => column.id !== target.column_id));
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "task-column", taskId: target.id, column: destination.name },
        run: () => task.move({ taskKey: keyOf(target), targetColumn: destination.name }, actor),
      };
    }
    case "order": {
      const target = pickTask(activeTasks);
      if (target == null) {
        return null;
      }
      const direction = rng.pick(DIRECTIONS);
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "none" },
        run: () => task.order({ taskKey: keyOf(target), direction }, actor),
      };
    }
    case "archive":
    case "unarchive": {
      const isArchive = operationName === "archive";
      const target = pickTask(isArchive ? activeTasks : archivedTasks);
      if (target == null) {
        return null;
      }
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "task-archived", taskId: target.id, archived: isArchive },
        run: () => (isArchive ? task.archive(keyOf(target), actor) : task.unarchive(keyOf(target), actor)),
      };
    }
    case "delete": {
      const target = pickTask(tasks);
      if (target == null) {
        return null;
      }
      // Deleting a task cascades its relations, which changes the other tasks' snapshots too.
      const counterparts = db
        .query<{ id: string }, [string, string, string]>(`SELECT CASE WHEN source_task_id = ? THEN target_task_id ELSE source_task_id END AS id
        FROM task_relations WHERE source_task_id = ? OR target_task_id = ?`)
        .all(target.id, target.id, target.id)
        .map((row) => row.id);
      return {
        name: operationName,
        touchTasks: [target.id, ...counterparts],
        touchLabels: [],
        expect: { kind: "task-deleted", taskId: target.id },
        run: () => task.delete(keyOf(target), actor),
      };
    }
    case "commentCreate": {
      const target = pickTask(tasks);
      if (target == null) {
        return null;
      }
      const commentCount = db
        .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM comment WHERE task_id = ?")
        .get(target.id)!.count;
      if (commentCount >= MAX_COMMENTS_PER_TASK) {
        return null;
      }
      const text = `${marker} comment ${rng.text(rng.integer(0, 200))}`;
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "comment-text", taskId: target.id, text },
        run: () => comment.create({ taskKey: keyOf(target), text }, actor),
      };
    }
    case "commentEdit":
    case "commentDelete": {
      const commented = db
        .query<{ task_id: string; task_number: number; number: number }, [string]>(`SELECT comment.task_id, task.number AS task_number, comment.number
        FROM comment JOIN task ON task.id = comment.task_id WHERE task.project_id = ?`)
        .all(projectMatch.id);
      if (commented.length === 0) {
        return null;
      }
      const target = rng.pick(commented);
      const commentKey = `${CRASH_PROJECT_KEY}-${target.task_number}#${target.number}`;
      if (operationName === "commentEdit") {
        const text = `${marker} comment edited`;
        return {
          name: operationName,
          touchTasks: [target.task_id],
          touchLabels: [],
          expect: { kind: "comment-text", taskId: target.task_id, text },
          run: () => comment.edit({ commentKey, text }, actor),
        };
      }
      return {
        name: operationName,
        touchTasks: [target.task_id],
        touchLabels: [],
        expect: { kind: "comment-deleted", taskId: target.task_id, number: target.number },
        run: () => comment.delete({ commentKey }, actor),
      };
    }
    case "labelAdd":
    case "labelRemove": {
      const target = pickTask(tasks);
      if (target == null || labels.length === 0) {
        return null;
      }
      const attached = new Set(
        db.query<{ label_id: string }, [string]>("SELECT label_id FROM task_label WHERE task_id = ?").all(target.id).map((row) => row.label_id),
      );
      const isAdd = operationName === "labelAdd";
      const candidates = labels.filter((candidate) => attached.has(candidate.id) !== isAdd);
      if (candidates.length === 0) {
        return null;
      }
      const chosen = rng.pick(candidates);
      const input = { taskKey: keyOf(target), labelNames: [chosen.name] };
      return {
        name: operationName,
        touchTasks: [target.id],
        touchLabels: [],
        expect: { kind: "task-label", taskId: target.id, labelId: chosen.id, attached: isAdd },
        run: () => (isAdd ? task.label.add(input, actor) : task.label.remove(input, actor)),
      };
    }
    case "relationCreate": {
      if (tasks.length < 2) {
        return null;
      }
      const source = rng.pick(tasks);
      const target = rng.pick(tasks.filter((candidate) => candidate.id !== source.id));
      const relationType = rng.pick(RELATION_TYPES);
      // Symmetric relations are stored with the smaller id first (operations/relation.ts).
      const isSwapped = relationType === "related" && source.id > target.id;
      const stored = isSwapped ? `${relationType}:${target.id}>${source.id}` : `${relationType}:${source.id}>${target.id}`;
      return {
        name: operationName,
        touchTasks: [source.id, target.id],
        touchLabels: [],
        expect: { kind: "relation", relation: stored, exists: true },
        run: () => relation.create({ sourceTaskKey: keyOf(source), targetTaskKey: keyOf(target), relation_type: relationType }, actor),
      };
    }
    case "relationDelete": {
      const relations = db
        .query<{ source_task_id: string; target_task_id: string; relation_type: (typeof RELATION_TYPES)[number]; source_number: number; target_number: number }, [string]>(`SELECT relation.source_task_id, relation.target_task_id, relation.relation_type,
          source.number AS source_number, target.number AS target_number
        FROM task_relations AS relation
        JOIN task AS source ON source.id = relation.source_task_id
        JOIN task AS target ON target.id = relation.target_task_id
        WHERE source.project_id = ?`)
        .all(projectMatch.id);
      if (relations.length === 0) {
        return null;
      }
      const chosen = rng.pick(relations);
      return {
        name: operationName,
        touchTasks: [chosen.source_task_id, chosen.target_task_id],
        touchLabels: [],
        expect: { kind: "relation", relation: `${chosen.relation_type}:${chosen.source_task_id}>${chosen.target_task_id}`, exists: false },
        run: () =>
          relation.delete(
            {
              sourceTaskKey: `${CRASH_PROJECT_KEY}-${chosen.source_number}`,
              targetTaskKey: `${CRASH_PROJECT_KEY}-${chosen.target_number}`,
              relation_type: chosen.relation_type,
            },
            actor,
          ),
      };
    }
    case "labelCreate": {
      const name = `L${marker}`;
      return {
        name: operationName,
        touchTasks: [],
        touchLabels: [],
        expect: { kind: "label-name", name },
        run: () => label.create({ name, color: rng.pick(LABEL_COLORS) }, actor),
        createdLabelId: (result) => (result as { id: string }).id,
      };
    }
    case "labelDelete": {
      const chosen = rng.pick(labels);
      const taskIds = db
        .query<{ task_id: string }, [string]>("SELECT task_id FROM task_label WHERE label_id = ?")
        .all(chosen.id)
        .map((row) => row.task_id);
      return {
        name: operationName,
        touchTasks: taskIds,
        touchLabels: [chosen.id],
        expect: { kind: "label-deleted", labelId: chosen.id },
        run: () => label.delete({ name: chosen.name }, actor),
      };
    }
    case "projectEdit": {
      const description = `${marker} project`;
      return {
        name: operationName,
        touchTasks: [],
        touchLabels: [],
        expect: { kind: "project-description", description },
        run: () => project.edit({ projectKey: CRASH_PROJECT_KEY, description }, actor),
      };
    }
  }
}

function runCrashMode() {
  const runNumber = Number(values.run);
  const db = getDb();

  // The first run creates the project. It is logged like any other operation.
  if (project.getByKey(CRASH_PROJECT_KEY) == null) {
    appendLog({ t: "begin", run: runNumber, seq: 0, op: "projectCreate", marker: "setup", touchTasks: [], touchLabels: [], expect: { kind: "none" } });
    project.create({ key: CRASH_PROJECT_KEY, name: "Crash" }, actor);
    appendLog({
      t: "ack",
      run: runNumber,
      seq: 0,
      tasks: {},
      labels: {},
      project: snapshotProject(db, CRASH_PROJECT_KEY),
      activityRowid: maxActivityRowid(db),
    });
  }

  console.log("ready");

  for (let seq = 1; seq <= MAX_OPERATIONS_PER_PROCESS; seq++) {
    const marker = `r${runNumber}s${seq}`;
    const planned = planCrashOperation(db, marker, random);
    if (planned == null) {
      continue;
    }

    appendLog({
      t: "begin",
      run: runNumber,
      seq,
      op: planned.name,
      marker,
      touchTasks: planned.touchTasks,
      touchLabels: planned.touchLabels,
      expect: planned.expect,
    });

    let result: unknown;
    try {
      result = planned.run();
    } catch (error) {
      // Domain refusals (a subtask cycle, an existing relation) are expected now and then.
      // They must leave no trace, which the parent checks.
      appendLog({ t: "fail", run: runNumber, seq, code: sqliteCode(error), error: String((error as Error).message) });
      continue;
    }

    const taskIds = [...planned.touchTasks];
    if (planned.createdTaskId != null) {
      taskIds.push(planned.createdTaskId(result));
    }
    const labelIds = [...planned.touchLabels];
    if (planned.createdLabelId != null) {
      labelIds.push(planned.createdLabelId(result));
    }

    appendLog({
      t: "ack",
      run: runNumber,
      seq,
      tasks: Object.fromEntries(taskIds.map((id) => [id, snapshotTask(db, id)])),
      labels: Object.fromEntries(labelIds.map((id) => [id, snapshotLabel(db, id)])),
      project: snapshotProject(db, CRASH_PROJECT_KEY),
      activityRowid: maxActivityRowid(db),
    });
  }
}

/** Announces BEGIN IMMEDIATE on stdout, then holds the lock briefly. Test-side only: core is unchanged. */
function instrumentLockAnnouncements(db: Database, currentSequence: () => number) {
  const originalExec = db.exec.bind(db);

  db.exec = (sql: string) => {
    originalExec(sql);

    if (sql === "BEGIN IMMEDIATE") {
      console.log(`LOCK ${currentSequence()}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_HOLD_MS);
    }
  };
}

function runContendMode() {
  const lane = values.lane!;
  const runNumber = Number(values.run);
  let seq = 0;

  let db: Database;
  try {
    db = getDb();
  } catch (error) {
    const cause = (error as Error).cause;
    console.log(`INITERR ${sqliteCode(cause) ?? "none"} ${String((error as Error).message).replaceAll("\n", " ")}`);
    process.exit(1);
  }

  instrumentLockAnnouncements(db, () => seq);
  const projectMatch = project.getByKey(CONTEND_PROJECT_KEY)!;
  const sharedTaskKey = `${CONTEND_PROJECT_KEY}-1`;
  console.log("ready");

  for (seq = 1; seq <= MAX_OPERATIONS_PER_PROCESS; seq++) {
    const marker = `${lane}r${runNumber}s${seq}`;
    const ownTasks = db
      .query<{ number: number; id: string }, [string, string]>("SELECT number, id FROM task WHERE project_id = ? AND title LIKE ? ORDER BY number")
      .all(projectMatch.id, `${lane}r%`);
    const operationName = random.weighted({ create: 4, comment: 4, edit: ownTasks.length > 0 ? 2 : 0 });
    const target = operationName === "edit" ? random.pick(ownTasks) : null;
    const text = `${marker} ${operationName}`;

    appendLog({ t: "begin", seq, op: operationName, marker, taskId: target?.id ?? null });
    const began = performance.now();

    try {
      let key: string;
      if (operationName === "create") {
        key = task.create({ project_id: projectMatch.id, title: text, description: random.text(200) }, actor).key;
      } else if (operationName === "comment") {
        key = comment.create({ taskKey: sharedTaskKey, text }, actor).key;
      } else {
        key = task.edit({ taskKey: `${CONTEND_PROJECT_KEY}-${target!.number}`, title: text }, actor).key;
      }

      appendLog({ t: "ack", seq, op: operationName, marker, key, taskId: target?.id ?? null });
      console.log(`ACK ${seq} ${Math.round(performance.now() - began)}`);
    } catch (error) {
      appendLog({ t: "fail", seq, code: sqliteCode(error), error: String((error as Error).message) });
      console.log(`ERR ${sqliteCode(error) ?? "none"} ${String((error as Error).message).replaceAll("\n", " ")} (during ${operationName})`);
    }
  }
}

function runSeedMode() {
  const taskCount = Number(values.tasks);
  const db = getDb();

  project.create({ key: SEED_PROJECT_KEY, name: "Backup source" }, actor);
  const projectMatch = project.getByKey(SEED_PROJECT_KEY)!;

  // One outer transaction makes seeding fast; each create runs in a savepoint inside it.
  db.transaction(() => {
    for (let index = 1; index <= taskCount; index++) {
      task.create(
        { project_id: projectMatch.id, title: `seeded ${index}`, description: random.text(random.integer(200, 1200)) },
        actor,
      );
    }
  }).immediate();

  console.log("done");
}

if (mode === "crash") {
  runCrashMode();
} else if (mode === "contend") {
  runContendMode();
} else if (mode === "seed") {
  runSeedMode();
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
