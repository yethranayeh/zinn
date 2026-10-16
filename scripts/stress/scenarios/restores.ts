/** Real CLI restores interrupted at transaction stages and raced with ordinary writers. */
import type { Options, ScenarioResult } from "../harness.ts";
import type { OlderStore, StoreRows } from "../migration-support.ts";

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Child,
  CLI_ENTRY,
  cliCommand,
  countBy,
  createResult,
  RunDirectory,
  runToCompletion,
  sleep,
} from "../harness.ts";
import {
  backupDirectoryOf,
  checkBackups,
  checkSearchIndex,
  compareStores,
  compareWithOlder,
  copyOlderStore,
  databasePathOf,
  LOCK_WAIT_MESSAGE,
  olderStoreTemplate,
  readEvents,
  readRows,
  waitForEvent,
} from "../migration-support.ts";
import { createRandom, deriveSeed } from "../random.ts";
import { SEED_PROJECT_KEY } from "../workload.ts";
import { checkZinnInvariants, openForChecks, withDatabase } from "../zinn-checks.ts";

const PRELOAD = join(import.meta.dir, "..", "restore-preload.ts");
const EVENTS = [
  "start",
  "locked",
  "backup-start",
  "backed-up",
  "copied",
  "before-commit",
  "after-commit",
  "writer-ready",
];
const KILL_STAGES = [
  "waiting",
  "backed-up",
  "copied",
  "before-commit",
  "after-commit",
  "random",
] as const;

// A linked database large enough to spill over 1 MiB, without adding synthetic writes to restore.
const FIXTURE_TASKS = 400;
const COMMAND_TIMEOUT_MS = 15_000;
const STAGE_TIMEOUT_MS = 5_000;
const PAUSE_MS = 10_000;
const POLL_MS = 5;
const MIN_SPILLED_BYTES = 1024 ** 2;
const RANDOM_WINDOW_MARGIN = 1.2;

// Use the migration scenarios' bounded scaling of --kills.
const KILLS_PER_ITERATION = 3;
const KILLS_PER_ROUND = 6;
const MIN_ROUNDS = 3;
const MIN_WRITERS = 2;
const LATER_WRITES = 2;
const TARGET_TASK = `${SEED_PROJECT_KEY}-1`;

type Fixture = { old: OlderStore; restored: StoreRows; backup: string };

function restoreCommand(backup: string) {
  return ["bun", "--preload", PRELOAD, CLI_ENTRY, "restore", backup, "--yes", "--json"];
}

async function command(directory: string, args: Array<string>) {
  const outcome = await runToCompletion(
    cliCommand([...args, "--json"]),
    directory,
    COMMAND_TIMEOUT_MS,
  );
  if (outcome.exitCode !== 0 || outcome.timedOut) {
    throw new Error(`${args.join(" ")} failed: ${outcome.stderr}`);
  }
  return outcome;
}

async function fixture(run: RunDirectory, seed: number): Promise<Fixture> {
  const linked = await olderStoreTemplate(run, FIXTURE_TASKS, deriveSeed(seed, "restore-fixture"));
  const oldDirectory = copyOlderStore(run, linked, "restore-old-template");
  const before = withDatabase(databasePathOf(oldDirectory), (db) => {
    db.exec("CREATE VIEW stress_board AS SELECT title FROM task");
    db.exec("CREATE INDEX stress_old_index ON task(title)");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return readRows(db, true);
  });
  const old = { template: oldDirectory, before, taskCount: FIXTURE_TASKS };
  const source = copyOlderStore(run, old, "restore-source");

  await command(source, ["task", "edit", TARGET_TASK, "--title", "seeded restored database"]);
  await command(source, ["task", "create", SEED_PROJECT_KEY, "--title", "seeded restored extra"]);
  await command(source, [
    "task",
    "comment",
    "create",
    TARGET_TASK,
    "--text",
    "restored fixture comment",
  ]);
  withDatabase(databasePathOf(source), (db) => {
    db.exec("DROP VIEW stress_board; CREATE VIEW stress_board AS SELECT description FROM task");
    db.exec("DROP INDEX stress_old_index; CREATE INDEX stress_restored_index ON task(description)");
  });

  const saved = await command(source, ["backup"]);
  const backup = (JSON.parse(saved.stdout) as { path: string }).path;
  const restored = withDatabase(backup, (db) => readRows(db, true));
  return { old, restored, backup };
}

function assertSound(path: string, expected: StoreRows) {
  return withDatabase(path, (db) => [
    ...compareStores(expected, readRows(db, true)),
    ...checkZinnInvariants(db),
    ...checkSearchIndex(db, expected.rows.task!.length),
  ]);
}

function requireChecks(problems: Array<string>, context: string) {
  if (problems.length > 0) {
    throw new Error(`${context}: ${problems.slice(0, 10).join("; ")}`);
  }
}

function stageReached(file: string, stage: string) {
  return readEvents(file, EVENTS).some((record) => record.event === stage);
}

async function waitUntil(check: () => boolean) {
  const began = performance.now();
  while (performance.now() - began < STAGE_TIMEOUT_MS) {
    if (check()) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error("Timed out waiting for the child process stage");
}

function fail(result: ScenarioResult, reproduce: string, directory: string, error: unknown) {
  result.failures.push({
    scenario: result.name,
    kind: "restore safety check",
    detail: `${String(error)}\n    reproduce: ${reproduce}`,
    keptDirectory: directory,
  });
}

export async function runRestoreKill(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const result = createResult("restore-kill");
  const stores = await fixture(run, options.seed);
  const random = createRandom(deriveSeed(options.seed, result.name));
  const outcomes: Array<string> = [];
  const walSizes: Array<number> = [];
  const calibration = copyOlderStore(run, stores.old, "restore-calibration");
  const calibrationEvents = join(calibration, "events.txt");
  const measured = await runToCompletion(
    restoreCommand(stores.backup),
    calibration,
    COMMAND_TIMEOUT_MS,
    { STRESS_EVENTS_FILE: calibrationEvents },
  );

  if (measured.exitCode !== 0) {
    fail(result, reproduce, calibration, measured.stderr);
    return result;
  }
  const timing = readEvents(calibrationEvents, EVENTS);
  const startedAt = timing.find((event) => event.event === "start")!.at;
  const committedAt = timing.find((event) => event.event === "after-commit")!.at;
  const elapsed = committedAt - startedAt;
  const windowMs = Math.ceil(elapsed * RANDOM_WINDOW_MARGIN);

  if (!options.keep) {
    run.remove(calibration);
  }

  const iterations = Math.max(KILL_STAGES.length, Math.ceil(options.kills / KILLS_PER_ITERATION));

  for (let iteration = 0; iteration < iterations; iteration++) {
    run.checkDisk();
    const stage = KILL_STAGES[iteration % KILL_STAGES.length]!;
    const directory = copyOlderStore(run, stores.old, "restore-kill");
    const events = join(directory, "events.txt");
    const environment: Record<string, string> = { STRESS_EVENTS_FILE: events };

    if (stage !== "waiting" && stage !== "random") {
      environment.STRESS_RESTORE_PAUSE_AT = stage;
      environment.STRESS_RESTORE_PAUSE_MS = String(PAUSE_MS);
    }

    let child: Child | undefined;
    let holder: ReturnType<typeof openForChecks> | undefined;

    try {
      if (stage === "waiting") {
        holder = openForChecks(databasePathOf(directory));
        holder.exec("BEGIN IMMEDIATE");
      }
      child = new Child(restoreCommand(stores.backup), directory, COMMAND_TIMEOUT_MS, environment);

      if (stage === "waiting") {
        await waitUntil(() => child!.stderr.includes(LOCK_WAIT_MESSAGE));
      } else {
        const reached = await waitForEvent(
          events,
          stage === "random" ? "start" : stage,
          STAGE_TIMEOUT_MS,
          EVENTS,
        );
        if (!reached) {
          throw new Error(`Stage ${stage} never reached: ${child.stderr}`);
        }
        if (stage === "random") {
          await sleep(random.integer(0, windowMs));
        }
      }

      child.kill();
      await child.exited;
      if (child.timedOut || (stage !== "random" && !child.wasKilled)) {
        throw new Error(`Stage ${stage} was not killed at its pause`);
      }

      holder?.exec("ROLLBACK");
      holder?.close();
      holder = undefined;
      result.iterations++;

      const recordedCommit = stageReached(events, "after-commit");
      if (stage !== "random" && recordedCommit !== (stage === "after-commit")) {
        throw new Error(`Stage ${stage} crossed the wrong side of COMMIT`);
      }

      const walPath = `${databasePathOf(directory)}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      if (["copied", "before-commit"].includes(stage)) {
        if (walBytes < MIN_SPILLED_BYTES) {
          throw new Error(
            `${stage} had only ${walBytes} WAL bytes; uncommitted spill was not exercised`,
          );
        }
        walSizes.push(walBytes);
      }

      const image = join(directory, "crash-image");
      mkdirSync(image);
      const imagePath = join(image, "zinn.sqlite");
      copyFileSync(databasePathOf(directory), imagePath);
      if (existsSync(walPath)) {
        copyFileSync(walPath, `${imagePath}-wal`);
      }
      // COMMIT may finish just before SIGKILL prevents the observer from recording it.
      const imageRows = withDatabase(imagePath, (db) => readRows(db, true));
      const committed =
        stage === "random"
          ? compareStores(stores.restored, imageRows).length === 0
          : recordedCommit;
      if (recordedCommit && !committed) {
        throw new Error("A recorded COMMIT did not leave the restored database");
      }

      const expected = committed ? stores.restored : stores.old.before;
      requireChecks(assertSound(imagePath, expected), `${stage} crash image`);
      requireChecks(assertSound(databasePathOf(directory), expected), `${stage} original store`);

      const backupInProgress =
        stageReached(events, "backup-start") && !stageReached(events, "backed-up");
      const saved = checkBackups(directory, stores.old.before, {
        allowsPartial: backupInProgress,
        exact: true,
      });
      requireChecks(saved.problems, `${stage} saved backups`);

      const finished = saved.names.filter((name) => name.endsWith(".sqlite"));
      if (finished.length !== (stageReached(events, "backed-up") ? 1 : 0)) {
        // A random kill can land after the atomic rename and before the observer records it.
        if (!(stage === "random" && backupInProgress && finished.length === 1)) {
          throw new Error(`${stage} left ${finished.length} completed backups`);
        }
      }

      for (const name of finished) {
        const backupPath = join(backupDirectoryOf(directory), name);
        requireChecks(assertSound(backupPath, stores.old.before), `${name} saved database`);
        const rollbackStore = copyOlderStore(run, stores.old, "restore-saved-backup");
        await command(rollbackStore, ["restore", stores.backup, "--yes"]);
        await command(rollbackStore, ["restore", backupPath, "--yes"]);
        requireChecks(
          assertSound(databasePathOf(rollbackStore), stores.old.before),
          `${name} round trip`,
        );
        if (!options.keep) {
          run.remove(rollbackStore);
        }
      }

      await command(directory, ["restore", stores.backup, "--yes"]);
      requireChecks(assertSound(databasePathOf(directory), stores.restored), "later restore");

      const afterRetry = readdirSync(backupDirectoryOf(directory));
      if (afterRetry.some((name) => !name.endsWith(".sqlite") && !saved.names.includes(name))) {
        throw new Error("The later restore left a new partial backup");
      }
      // Check the killed run's files before retry: a retry is allowed to preserve unfinished backups.
      outcomes.push(
        `${stage}: ${committed ? "committed" : "rolled back"}${backupInProgress ? " (backup interrupted)" : ""}${child.wasKilled ? "" : " (finished before kill)"}`,
      );
    } catch (error) {
      fail(result, reproduce, directory, error);
    } finally {
      child?.kill();

      await child?.exited;

      if (holder != null) {
        holder.exec("ROLLBACK");
        holder.close();
      }
    }

    if (result.failures.length > 0) {
      return result;
    }

    if (!options.keep) {
      run.remove(directory);
    }
  }

  result.notes.push(
    `random kill window 0-${windowMs} ms after restore starts; ${countBy(outcomes)
      .map(([outcome, count]) => `${count}x ${outcome}`)
      .join("; ")}`,
  );

  result.notes.push(
    `uncommitted WAL at copied/before-commit kills: ${Math.min(...walSizes)}-${Math.max(...walSizes)} bytes`,
  );
  return result;
}

type Write = { kind: "task" | "comment"; marker: string; args: Array<string>; fails: boolean };
type Outcome = Awaited<ReturnType<typeof runToCompletion>>;

function writes(round: number, phase: string, count: number): Array<Write> {
  return Array.from({ length: count }, (_, index) => {
    const kind = index % 2 === 0 ? "task" : "comment";
    const marker = `seeded write-${round}-${phase}-${index}`;
    const args =
      kind === "task"
        ? ["task", "create", SEED_PROJECT_KEY, "--title", marker]
        : ["task", "comment", "create", TARGET_TASK, "--text", marker];

    return { kind, marker, args, fails: false };
  });
}

function checkWrites(base: StoreRows, after: StoreRows, acknowledged: Array<Write>) {
  const tasks = acknowledged.filter((write) => write.kind === "task").length;
  const comments = acknowledged.length - tasks;
  const problems = compareWithOlder(base, after, tasks > 0, comments > 0);

  if (
    base.version !== after.version ||
    JSON.stringify(base.schema) !== JSON.stringify(after.schema)
  ) {
    problems.push("writer changed the schema or version");
  }

  const additions = [
    ["task", tasks],
    ["comment", comments],
    ["activity", acknowledged.length],
    ["task_search", tasks],
  ] as const;

  for (const [table, added] of additions) {
    if (after.rows[table]!.length !== base.rows[table]!.length + added) {
      problems.push(`${table} row count differs from acknowledged writes`);
    }
  }

  return problems;
}

function occurrences(rows: StoreRows, write: Write) {
  const table = write.kind === "task" ? "task" : "comment";
  const field = write.kind === "task" ? "title" : "text";

  return rows.rows[table]!.filter((row) => JSON.parse(row)[field] === write.marker).length;
}

export async function runRestoreConcurrentWriter(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const result = createResult("restore-concurrent-writer");
  const stores = await fixture(run, options.seed);
  const processCount = Math.max(MIN_WRITERS, options.processes);
  const rounds = Math.max(MIN_ROUNDS, Math.ceil(options.kills / KILLS_PER_ROUND));

  for (let round = 0; round < rounds; round++) {
    run.checkDisk();
    const directory = copyOlderStore(run, stores.old, result.name);
    const events = join(directory, "events.txt");
    const release = join(directory, "release");
    const children: Array<Child> = [];

    try {
      const beforeWrites = writes(round, "before", processCount);
      const beforeOutcomes = await Promise.all(
        beforeWrites.map((write) =>
          runToCompletion(cliCommand([...write.args, "--json"]), directory, COMMAND_TIMEOUT_MS),
        ),
      );
      const restoring = new Child(restoreCommand(stores.backup), directory, COMMAND_TIMEOUT_MS, {
        STRESS_EVENTS_FILE: events,
        STRESS_RESTORE_PAUSE_AT: "backed-up",
        STRESS_RESTORE_PAUSE_MS: String(PAUSE_MS),
        STRESS_RESTORE_RELEASE_FILE: release,
      });
      children.push(restoring);
      const backupFinished = await waitForEvent(events, "backed-up", STAGE_TIMEOUT_MS, EVENTS);

      if (!backupFinished) {
        throw new Error(`Restore never finished its backup: ${restoring.stderr}`);
      }

      const duringWrites = writes(round, "waiting", processCount);
      const rejectedMarker = `seeded rejected-label-${round}`;
      duringWrites.push({
        kind: "task",
        marker: rejectedMarker,
        fails: true,
        args: [
          "task",
          "create",
          SEED_PROJECT_KEY,
          "--title",
          rejectedMarker,
          "--label",
          "missing-stress-label",
        ],
      });

      const waiters = duringWrites.map(
        (write) =>
          new Child(
            ["bun", "--preload", PRELOAD, CLI_ENTRY, ...write.args, "--json"],
            directory,
            COMMAND_TIMEOUT_MS,
            { STRESS_EVENTS_FILE: events, STRESS_RESTORE_WRITER: "1" },
          ),
      );

      children.push(...waiters);
      await waitUntil(
        () =>
          readEvents(events, EVENTS).filter((event) => event.event === "writer-ready").length ===
          waiters.length,
      );

      if (waiters.some((child) => child.lines.length > 0 || child.process.exitCode != null)) {
        throw new Error("A writer finished while restore still held its lock");
      }

      writeFileSync(release, "release\n");
      const codes = await Promise.all([restoring.exited, ...waiters.map((child) => child.exited)]);
      if (codes[0] !== 0 || restoring.timedOut) {
        throw new Error(`Restore failed: ${restoring.stderr}`);
      }

      const duringOutcomes = waiters.map(
        (child, index): Outcome => ({
          exitCode: codes[index + 1]!,
          stdout: child.lines.join("\n"),
          stderr: child.stderr,
          timedOut: child.timedOut,
          durationMs: performance.now() - child.startedAt,
        }),
      );

      const afterWrites = writes(round, "after", LATER_WRITES);
      // A rejected CLI input must leave no task, activity or counter increment.
      afterWrites.push({
        kind: "task",
        marker: `seeded rejected-${round}`,
        fails: true,
        args: [
          "task",
          "create",
          SEED_PROJECT_KEY,
          "--title",
          `seeded rejected-${round}`,
          "--priority",
          "invalid",
        ],
      });
      const afterOutcomes = await Promise.all(
        afterWrites.map((write) =>
          runToCompletion(cliCommand([...write.args, "--json"]), directory, COMMAND_TIMEOUT_MS),
        ),
      );
      const allWrites = [...beforeWrites, ...duringWrites, ...afterWrites];
      const allOutcomes = [...beforeOutcomes, ...duringOutcomes, ...afterOutcomes];
      const report = JSON.parse(restoring.lines.join("\n")) as { backupPath: string };
      const saved = withDatabase(report.backupPath, (db) => readRows(db, true));
      const current = withDatabase(databasePathOf(directory), (db) => readRows(db, true));
      const beforeAcknowledged: Array<Write> = [];
      const afterAcknowledged: Array<Write> = [];
      const problems: Array<string> = [];

      allWrites.forEach((write, index) => {
        const outcome = allOutcomes[index]!;
        const hasUnexpectedExit = write.fails ? outcome.exitCode === 0 : outcome.exitCode !== 0;
        if (outcome.timedOut || hasUnexpectedExit) {
          problems.push(`${write.marker}: unexpected exit ${outcome.exitCode}: ${outcome.stderr}`);
        }

        const inBackup = occurrences(saved, write);
        const inStore = occurrences(current, write);
        const succeeded = outcome.exitCode === 0;

        if (inBackup + inStore !== (succeeded ? 1 : 0)) {
          problems.push(
            `${write.marker}: ${inBackup} in backup, ${inStore} in restored database, exit ${outcome.exitCode}`,
          );
        }

        if (succeeded) {
          const ack = JSON.parse(outcome.stdout) as { key: string; title?: string; text?: string };
          const destination = inBackup === 1 ? saved : current;
          const field = write.kind === "task" ? "title" : "text";
          const row = destination.rows[write.kind]!.map((row) => JSON.parse(row)).find(
            (row) => row[field] === write.marker,
          );
          const key =
            row == null
              ? null
              : write.kind === "task"
                ? `${SEED_PROJECT_KEY}-${row.number}`
                : `${TARGET_TASK}#${row.number}`;

          if (key !== ack.key || ack[field] !== write.marker) {
            problems.push(
              `${write.marker}: acknowledged key or content missing from its destination`,
            );
          }

          if (row != null) {
            const targetId = destination.rows
              .task!.map((row) => JSON.parse(row))
              .find((task) => task.number === 1)!.id;

            if (write.kind === "comment" && row.task_id !== targetId) {
              problems.push(`${write.marker}: comment belongs to the wrong task`);
            }

            const activities = destination.rows
              .activity!.map((activity) => JSON.parse(activity))
              .filter((activity) => {
                if (write.kind === "task") {
                  return activity.action === "create" && activity.entity_id === row.id;
                }

                const comment =
                  activity.changes == null ? null : JSON.parse(activity.changes).comment;

                return (
                  activity.action === "comment_create" &&
                  activity.entity_id === row.task_id &&
                  comment?.id === row.id &&
                  comment.text === write.marker
                );
              });

            if (activities.length !== 1) {
              problems.push(`${write.marker}: missing or duplicated create activity`);
            }
          }
          (inBackup === 1 ? beforeAcknowledged : afterAcknowledged).push(write);
        } else if (
          Object.values(saved.rows)
            .concat(Object.values(current.rows))
            .some((rows) => rows.some((row) => row.includes(write.marker)))
        ) {
          problems.push(`${write.marker}: failed write left a trace`);
        }
        const expectedBefore = index < beforeWrites.length;
        if (succeeded && (inBackup === 1) !== expectedBefore) {
          problems.push(`${write.marker}: write landed on the wrong side of restore`);
        }
      });
      problems.push(...checkWrites(stores.old.before, saved, beforeAcknowledged));
      problems.push(...checkWrites(stores.restored, current, afterAcknowledged));
      for (const [path, rows] of [
        [report.backupPath, saved],
        [databasePathOf(directory), current],
      ] as const) {
        problems.push(
          ...withDatabase(path, (db) => [
            ...checkZinnInvariants(db),
            ...checkSearchIndex(db, rows.rows.task!.length),
          ]),
        );
      }
      if (readdirSync(backupDirectoryOf(directory)).length !== 1) {
        problems.push("Restore did not leave exactly one completed backup");
      }
      requireChecks(problems, `round ${round}`);
      result.iterations++;
      result.notes.push(
        `round ${round}: ${beforeAcknowledged.length} writes saved before restore, ${afterAcknowledged.length} on restored database; ${waiters.length} writers waited for the held lock; rejected writes left no trace`,
      );
    } catch (error) {
      fail(result, reproduce, directory, error);
    } finally {
      for (const child of children) {
        child.kill();
      }
      await Promise.all(children.map((child) => child.exited));
    }
    if (result.failures.length > 0) {
      return result;
    }
    if (!options.keep) {
      run.remove(directory);
    }
  }
  return result;
}
