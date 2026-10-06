/**
 * Scenarios for upgrading an older store (see migration-preload.ts for how the CLI gets a test-only
 *  migration, since core ships an empty chain). All of them run the real CLI against isolated stores.
 *
 *   migrate-open-race   several processes run ordinary commands on one older store at once: exactly one
 *                       upgrades and takes the one backup, the rest find it current; rows survive.
 *   migrate-race        `zinn migrate` and ordinary commands race to upgrade one older store: whoever
 *                       wins, there is one upgrade and one backup, and migrate reports it truthfully.
 *   migrate-lock-timeout  callers that wait longer than their budget for a running upgrade, an ordinary
 *                       writer, a reader and `zinn migrate`, stop with the timeout message and change
 *                       nothing, while the upgrade carries on.
 *   migrate-kill        SIGKILL the upgrading process at each stage of the migration, including after
 *                       the page cache spilled uncommitted pages into the -wal file: the store keeps its
 *                       old version, rows and search index, the backup is usable, and the next run
 *                       upgrades it from scratch.
 *   migrate-create-race  several processes create one fresh store at once, with the test migration in
 *                       the chain: one creates it and runs the chain, the rest open it normally; no backup.
 *   migrate-sizing      the disk space an upgrade really takes (main file with its -wal and -shm files,
 *                       and the backup, sampled while it runs) stays below the runner's own estimate for
 *                       the same store. SQLite's temporary files are not sampled: it unlinks them as soon
 *                       as it opens them, so no directory listing shows them.
 */
import type { Options, ScenarioResult } from "../harness.ts";

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readSchemaVersion } from "../../../packages/core/src/migrations/runner.ts";
import { estimateRequiredFree, measureSpace } from "../../../packages/core/src/migrations/space.ts";
import {
  Child,
  countBy,
  createResult,
  formatBytes,
  RunDirectory,
  runToCompletion,
  sleep,
} from "../harness.ts";
import {
  backupDirectoryOf,
  checkBackups,
  checkSearchIndex,
  checkUpgraded,
  compareWithOlder,
  copyOlderStore,
  countMigrationStarts,
  databasePathOf,
  errorMessageOf,
  LOCK_WAIT_MESSAGE,
  migratingCliCommand,
  OLDER_VERSION,
  olderStoreTemplate,
  readEvents,
  readRows,
  UPGRADED_VERSION,
  waitForEvent,
} from "../migration-support.ts";
import { createRandom, deriveSeed, type Random } from "../random.ts";
import { MIGRATION_EVENTS, type MigrationEvent, STRESS_MIGRATION } from "../stress-migration.ts";
import { checkZinnInvariants, withDatabase } from "../zinn-checks.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const PROJECT_KEY = "BAK";
// Tasks in the older store the race scenarios copy: enough rows to check, quick to copy and rebuild.
const RACE_STORE_TASKS = 400;
// The test migration holds the write lock this long, so the other processes are certain to wait for it.
const LOCK_HOLD_MS = 400;
// The lock-timeout scenario: how long the upgrade holds the lock, how long waiters may wait, and how many rounds.
const TIMEOUT_HOLD_MS = 2_000;
const TIMEOUT_BUDGET_MS = 800;
const TIMEOUT_ROUNDS = 2;
const UPGRADE_START_WAIT_MS = 30_000;
// Room for process start and scheduling when checking how long a waiter took.
const WAIT_SLACK_MS = 1_500;
// The kill scenario: pause this long at the stage to be killed (the kill comes far sooner), write this much
//  in a scratch table so uncommitted pages reach the -wal file, and run one iteration per this many --kills.
const KILL_PAUSE_MS = 10_000;
const KILL_SPILL_BYTES = 6 * 1024 ** 2;
const KILLS_PER_KILL_ITERATION = 3;
const STAGE_WAIT_MS = 30_000;
// A kill at a random moment after the upgrade starts may land before or after the commit.
const RANDOM_STAGE = "random";
// The page cache holds about 2 MB by default, so a write this much larger must have spilled into the -wal file.
const MIN_SPILLED_WAL_BYTES = 1024 ** 2;
const WINDOW_MARGIN = 1.2;
// The sizing scenario: store sizes in tasks, how often the sampler reads file sizes, and how long the
//  migration waits before its commit so the sampler sees the -wal file at its largest.
const SIZING_STORE_TASKS = [400, 2000];
const SAMPLE_INTERVAL_MS = 2;
const SIZING_PAUSE_MS = 200;
// stat reports allocation in 512-byte blocks.
const STAT_BLOCK_BYTES = 512;
// One round per this many --kills, at least MIN_ROUNDS.
const KILLS_PER_ROUND = 6;
const MIN_ROUNDS = 3;

function roundsFor(options: Options) {
  return Math.max(MIN_ROUNDS, Math.ceil(options.kills / KILLS_PER_ROUND));
}

type RoundContext = {
  scenario: string;
  reproduce: string;
  keep: Array<string>;
  result: ScenarioResult;
};

function failer({ scenario, reproduce, keep, result }: RoundContext) {
  return (kind: string, detail: string, directory: string) => {
    keep.push(directory);
    result.failures.push({
      scenario,
      kind,
      detail: `${detail}\n    reproduce: ${reproduce}`,
      keptDirectory: directory,
    });
  };
}

/** Removes a round's directories unless it failed or the run keeps everything. */
function cleanUp(
  run: RunDirectory,
  options: Options,
  keep: Array<string>,
  directories: Array<string>,
) {
  for (const directory of directories) {
    if (!options.keep && !keep.includes(directory) && existsSync(directory)) {
      run.remove(directory);
    }
  }
}

function ordinaryCommand(index: number): { kind: string; args: Array<string> } {
  const commands = [
    { kind: "create", args: ["task", "create", PROJECT_KEY, "--title", `race ${index}`] },
    { kind: "list", args: ["task", "list", PROJECT_KEY] },
    { kind: "projects", args: ["project", "list"] },
    { kind: "search", args: ["task", "search", "seeded"] },
    { kind: "create", args: ["task", "create", PROJECT_KEY, "--title", `race ${index}`] },
    { kind: "view", args: ["task", "view", `${PROJECT_KEY}-1`] },
  ];

  return commands[index % commands.length]!;
}

export async function runMigrateOpenRace(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-open-race";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });
  const store = await olderStoreTemplate(
    run,
    RACE_STORE_TASKS,
    deriveSeed(options.seed, `${scenario}-store`),
  );
  const processCount = Math.max(options.processes, 2);
  const waitingCounts: Array<number> = [];
  const errors: Array<string> = [];

  for (let round = 0; round < roundsFor(options); round++) {
    const zinnDirectory = copyOlderStore(run, store, scenario);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");
    const environment = {
      STRESS_EVENTS_FILE: eventsFile,
      STRESS_MIGRATION_PAUSE_AT: "rebuilt",
      STRESS_MIGRATION_PAUSE_MS: String(LOCK_HOLD_MS),
    };

    try {
      const commands = Array.from({ length: processCount }, (_, index) => ordinaryCommand(index));
      const outcomes = await Promise.all(
        commands.map((command) =>
          runToCompletion(
            migratingCliCommand([...command.args, "--json"]),
            zinnDirectory,
            COMMAND_TIMEOUT_MS,
            environment,
          ),
        ),
      );
      result.iterations++;

      const failed = outcomes.filter((outcome) => outcome.exitCode !== 0);
      for (const outcome of failed) {
        errors.push(errorMessageOf(outcome.stderr));
      }
      if (failed.length > 0) {
        fail(
          "an ordinary command failed on an older store",
          `round ${round}: ${countBy(failed.map((outcome) => errorMessageOf(outcome.stderr)))
            .map(([message, count]) => `${count}x ${message}`)
            .join("\n    ")}`,
          zinnDirectory,
        );
        continue;
      }

      const starts = countMigrationStarts(eventsFile);
      if (starts !== 1) {
        fail(
          "not exactly one upgrade",
          `round ${round}: the migration ran ${starts} times across ${processCount} processes`,
          zinnDirectory,
        );
      }

      const waiting = outcomes.filter((outcome) => outcome.stderr.includes(LOCK_WAIT_MESSAGE));
      waitingCounts.push(waiting.length);
      const unexpected = outcomes.filter(
        (outcome) => outcome.stderr.replace(LOCK_WAIT_MESSAGE, "").trim() !== "",
      );
      if (unexpected.length > 0) {
        fail(
          "unexpected output on stderr",
          `round ${round}: ${unexpected[0]!.stderr.trim().slice(0, 300)}`,
          zinnDirectory,
        );
      }
      if (waiting.length === 0) {
        fail(
          "no process waited for the upgrade",
          `round ${round}: the race did not happen, so it checked nothing`,
          zinnDirectory,
        );
      }

      const backups = checkBackups(zinnDirectory, store.before);
      if (backups.names.length !== 1) {
        fail(
          "not exactly one backup",
          `round ${round}: ${backups.names.length} files in backups/: ${backups.names.join(", ")}`,
          zinnDirectory,
        );
      }
      if (backups.problems.length > 0) {
        fail(
          "backup is not the older store",
          `round ${round}: ${backups.problems.slice(0, 5).join("\n    ")}`,
          zinnDirectory,
        );
      }

      const created = commands.filter(
        (command, index) => command.kind === "create" && outcomes[index]!.exitCode === 0,
      ).length;
      const problems = checkUpgraded(zinnDirectory, store.before, created > 0);
      const taskCount = withDatabase(
        databasePathOf(zinnDirectory),
        (db) => db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count,
      );
      if (taskCount !== store.taskCount + created) {
        problems.push(
          `${taskCount} tasks, expected ${store.taskCount} older ones plus ${created} acknowledged creates`,
        );
      }
      if (problems.length > 0) {
        fail(
          "upgraded store is not intact",
          `round ${round}: ${problems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  result.notes.push(
    `${processCount} processes per round on a ${store.taskCount}-task older store, ${result.iterations} rounds; processes that waited for the upgrade per round: ${waitingCounts.join(", ")}`,
  );
  if (errors.length > 0) {
    result.notes.push(
      `errors: ${countBy(errors)
        .map(([message, count]) => `${count}x ${message}`)
        .join("; ")}`,
    );
  }

  return result;
}

type MigrateOutput = {
  changed: boolean;
  backupPath: string | null;
  previousVersion: number;
  finalVersion: number;
};

function shuffle<T>(items: Array<T>, random: Random) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = random.integer(0, index);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }

  return shuffled;
}

export async function runMigrateRace(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-race";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });
  const random = createRandom(deriveSeed(options.seed, scenario));
  const store = await olderStoreTemplate(
    run,
    RACE_STORE_TASKS,
    deriveSeed(options.seed, `${scenario}-store`),
  );
  const processCount = Math.max(options.processes, 2);
  const upgraders: Array<string> = [];

  for (let round = 0; round < roundsFor(options); round++) {
    const zinnDirectory = copyOlderStore(run, store, scenario);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");
    const environment = {
      STRESS_EVENTS_FILE: eventsFile,
      STRESS_MIGRATION_PAUSE_AT: "rebuilt",
      STRESS_MIGRATION_PAUSE_MS: String(LOCK_HOLD_MS),
    };

    try {
      // Half of the processes run `zinn migrate`, the others an ordinary command that upgrades by itself.
      const commands = shuffle(
        Array.from({ length: processCount }, (_, index) =>
          index % 2 === 0 ? { kind: "migrate", args: ["migrate"] } : ordinaryCommand(index),
        ),
        random,
      );
      const outcomes = await Promise.all(
        commands.map((command) =>
          runToCompletion(
            migratingCliCommand([...command.args, "--json"]),
            zinnDirectory,
            COMMAND_TIMEOUT_MS,
            environment,
          ),
        ),
      );
      result.iterations++;

      const failed = outcomes.filter((outcome) => outcome.exitCode !== 0);
      if (failed.length > 0) {
        fail(
          "a command failed while racing to upgrade",
          `round ${round}: ${countBy(failed.map((outcome) => errorMessageOf(outcome.stderr)))
            .map(([message, count]) => `${count}x ${message}`)
            .join("\n    ")}`,
          zinnDirectory,
        );
        continue;
      }

      const starts = countMigrationStarts(eventsFile);
      if (starts !== 1) {
        fail(
          "not exactly one upgrade",
          `round ${round}: the migration ran ${starts} times`,
          zinnDirectory,
        );
      }

      const backups = checkBackups(zinnDirectory, store.before);
      if (backups.names.length !== 1) {
        fail(
          "not exactly one backup",
          `round ${round}: ${backups.names.length} files in backups/: ${backups.names.join(", ")}`,
          zinnDirectory,
        );
      }
      if (backups.problems.length > 0) {
        fail(
          "backup is not the older store",
          `round ${round}: ${backups.problems.slice(0, 5).join("\n    ")}`,
          zinnDirectory,
        );
      }

      // `zinn migrate` must say it changed the database exactly when it did, and name the one backup.
      const reports = commands.flatMap((command, index) =>
        command.kind === "migrate" ? [JSON.parse(outcomes[index]!.stdout) as MigrateOutput] : [],
      );
      const upgradedByMigrate = reports.filter((report) => report.changed);
      const reportProblems = [
        ...(upgradedByMigrate.length > 1
          ? [`${upgradedByMigrate.length} migrate commands report they upgraded`]
          : []),
        ...reports
          .filter((report) => report.finalVersion !== 2)
          .map((report) => `a migrate command reports final version ${report.finalVersion}`),
        ...upgradedByMigrate
          .filter(
            (report) =>
              report.backupPath == null ||
              !backups.names.includes(report.backupPath.split("/").at(-1)!),
          )
          .map(() => "a migrate command that upgraded does not name the backup that exists"),
        ...reports
          .filter((report) => !report.changed && report.backupPath != null)
          .map(() => "a migrate command that changed nothing names a backup"),
      ];
      if (reportProblems.length > 0) {
        fail(
          "migrate reported its outcome wrongly",
          `round ${round}: ${reportProblems.join("\n    ")}`,
          zinnDirectory,
        );
      }
      upgraders.push(upgradedByMigrate.length === 1 ? "migrate" : "ordinary command");

      const created = commands.filter(
        (command, index) => command.kind === "create" && outcomes[index]!.exitCode === 0,
      ).length;
      const problems = checkUpgraded(zinnDirectory, store.before, created > 0);
      const taskCount = withDatabase(
        databasePathOf(zinnDirectory),
        (db) => db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count,
      );
      if (taskCount !== store.taskCount + created) {
        problems.push(
          `${taskCount} tasks, expected ${store.taskCount} older ones plus ${created} acknowledged creates`,
        );
      }
      if (problems.length > 0) {
        fail(
          "upgraded store is not intact",
          `round ${round}: ${problems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  result.notes.push(
    `${processCount} processes per round (half \`migrate\`, half ordinary commands), ${result.iterations} rounds; who upgraded: ${countBy(
      upgraders,
    )
      .map(([who, count]) => `${count}x ${who}`)
      .join(", ")}`,
  );
  return result;
}

export async function runMigrateLockTimeout(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-lock-timeout";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });
  const store = await olderStoreTemplate(
    run,
    RACE_STORE_TASKS,
    deriveSeed(options.seed, `${scenario}-store`),
  );
  const waitedMs: Array<number> = [];

  for (let round = 0; round < TIMEOUT_ROUNDS; round++) {
    const zinnDirectory = copyOlderStore(run, store, scenario);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");
    const environment = {
      STRESS_EVENTS_FILE: eventsFile,
      STRESS_MIGRATION_PAUSE_AT: "rebuilt",
      STRESS_MIGRATION_PAUSE_MS: String(TIMEOUT_HOLD_MS),
      STRESS_LOCK_BUDGET_MS: String(TIMEOUT_BUDGET_MS),
    };
    // The running upgrade is an automatic one in one round and `zinn migrate` in the other.
    const upgraderArgs =
      round % 2 === 0 ? ["task", "create", PROJECT_KEY, "--title", "upgrader"] : ["migrate"];
    const waiters = [
      {
        kind: "ordinary writer",
        args: ["task", "create", PROJECT_KEY, "--title", "waiter must not exist"],
      },
      { kind: "ordinary reader", args: ["task", "list", PROJECT_KEY] },
      { kind: "migrate", args: ["migrate"] },
    ];

    try {
      const upgrader = runToCompletion(
        migratingCliCommand([...upgraderArgs, "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        environment,
      );
      const started = await waitForEvent(eventsFile, "start", UPGRADE_START_WAIT_MS);
      if (!started) {
        fail("the upgrade did not start", `round ${round}`, zinnDirectory);
        await upgrader;
        continue;
      }

      const waiterOutcomes = await Promise.all(
        waiters.map((waiter) =>
          runToCompletion(
            migratingCliCommand([...waiter.args, "--json"]),
            zinnDirectory,
            COMMAND_TIMEOUT_MS,
            environment,
          ),
        ),
      );
      const upgraderOutcome = await upgrader;
      result.iterations++;

      waiters.forEach((waiter, index) => {
        const outcome = waiterOutcomes[index]!;
        const message = errorMessageOf(outcome.stderr);
        const problems: Array<string> = [];
        if (outcome.exitCode === 0) {
          problems.push("it succeeded while the upgrade held the lock");
        }
        if (
          !message.includes(
            `Waited ${(TIMEOUT_BUDGET_MS / 1000).toFixed(1)} seconds for another writer`,
          ) ||
          !message.includes("applied no changes") ||
          !message.includes(databasePathOf(zinnDirectory))
        ) {
          problems.push(
            `timeout message is missing its wait, path or "applied no changes": ${message}`,
          );
        }
        if (!outcome.stderr.includes(`Waiting up to ${TIMEOUT_BUDGET_MS / 1000} seconds`)) {
          problems.push("it never said it was waiting");
        }
        if (
          outcome.durationMs > TIMEOUT_HOLD_MS + WAIT_SLACK_MS ||
          outcome.durationMs < TIMEOUT_BUDGET_MS
        ) {
          problems.push(
            `it ran ${Math.round(outcome.durationMs)} ms, expected about the ${TIMEOUT_BUDGET_MS} ms budget`,
          );
        }
        waitedMs.push(outcome.durationMs);
        if (problems.length > 0) {
          fail(
            "a waiting caller did not time out as documented",
            `round ${round}, ${waiter.kind}: ${problems.join("; ")}`,
            zinnDirectory,
          );
        }
      });

      if (upgraderOutcome.exitCode !== 0) {
        fail(
          "the running upgrade failed",
          `round ${round}: ${errorMessageOf(upgraderOutcome.stderr)}`,
          zinnDirectory,
        );
        continue;
      }

      const starts = countMigrationStarts(eventsFile);
      const backups = checkBackups(zinnDirectory, store.before);
      const upgraderCreated = upgraderArgs[0] === "task" ? 1 : 0;
      // The waiters changed nothing: only the upgrader's own work is in the store.
      const problems = checkUpgraded(zinnDirectory, store.before, upgraderCreated > 0);
      const taskCount = withDatabase(
        databasePathOf(zinnDirectory),
        (db) => db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task").get()!.count,
      );
      if (taskCount !== store.taskCount + upgraderCreated) {
        problems.push(
          `${taskCount} tasks, expected ${store.taskCount} plus ${upgraderCreated} from the upgrader`,
        );
      }
      if (starts !== 1) {
        problems.push(`the migration ran ${starts} times`);
      }
      if (backups.names.length !== 1) {
        problems.push(`${backups.names.length} backups: ${backups.names.join(", ")}`);
      }
      problems.push(...backups.problems);
      if (problems.length > 0) {
        fail(
          "a timed-out caller changed something, or the upgrade did not finish cleanly",
          `round ${round}: ${problems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }

      // Once the upgrade is done, the same callers succeed: nothing was left half-done by the timeouts.
      const retry = await runToCompletion(
        migratingCliCommand(["migrate", "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        environment,
      );
      const retryResult = retry.exitCode === 0 ? (JSON.parse(retry.stdout) as MigrateOutput) : null;
      if (retryResult == null || retryResult.changed || retryResult.backupPath != null) {
        fail(
          "migrate after the upgrade is not a no-op",
          `round ${round}: exit ${retry.exitCode} ${retry.stdout} ${retry.stderr.trim()}`,
          zinnDirectory,
        );
      }
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  result.notes.push(
    `ordinary writer, ordinary reader and migrate waited ${waitedMs.map((milliseconds) => Math.round(milliseconds)).join(", ")} ms against a ${TIMEOUT_BUDGET_MS} ms budget while the upgrade held the lock for ${TIMEOUT_HOLD_MS} ms`,
  );
  return result;
}

type KillStage = MigrationEvent | typeof RANDOM_STAGE;
const KILL_STAGES: Array<KillStage> = [...MIGRATION_EVENTS, RANDOM_STAGE];
const SPILLED_STAGES: Array<KillStage> = ["spilled", "before-commit"];

/** Copies the database file and its -wal file as the kill left them, and opens that copy to check it. */
function checkCrashImage(
  run: RunDirectory,
  zinnDirectory: string,
  check: (path: string) => Array<string>,
) {
  const imageDirectory = run.create("migration-image");

  try {
    const imagePath = join(imageDirectory, "zinn.sqlite");
    const databasePath = databasePathOf(zinnDirectory);
    copyFileSync(databasePath, imagePath);
    if (existsSync(`${databasePath}-wal`)) {
      copyFileSync(`${databasePath}-wal`, `${imagePath}-wal`);
    }

    return check(imagePath);
  } finally {
    run.remove(imageDirectory);
  }
}

export async function runMigrateKill(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-kill";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });
  const random = createRandom(deriveSeed(options.seed, scenario));
  const store = await olderStoreTemplate(
    run,
    RACE_STORE_TASKS,
    deriveSeed(options.seed, `${scenario}-store`),
  );
  const iterations = Math.max(
    KILL_STAGES.length,
    Math.ceil(options.kills / KILLS_PER_KILL_ITERATION),
  );
  const outcomes: Array<string> = [];
  const walAtKill = new Map<KillStage, Array<number>>();

  // An uncontested upgrade with the same spill shows how long a random-moment kill may wait.
  const calibrationDirectory = copyOlderStore(run, store, `${scenario}-calibration`);
  const calibrationEvents = run.create(`${scenario}-events`);
  const calibrationEventsFile = join(calibrationEvents, "events.txt");
  const calibrated = await runToCompletion(
    migratingCliCommand(["migrate", "--json"]),
    calibrationDirectory,
    COMMAND_TIMEOUT_MS,
    {
      STRESS_EVENTS_FILE: calibrationEventsFile,
      STRESS_MIGRATION_SPILL_BYTES: String(KILL_SPILL_BYTES),
    },
  );
  const calibrationStart = readEvents(calibrationEventsFile).find(
    (record) => record.event === "start",
  );
  const upgradeMs = calibrationStart == null ? 0 : Date.now() - calibrationStart.at;
  cleanUp(run, options, keep, [calibrationDirectory, calibrationEvents]);
  if (calibrated.exitCode !== 0 || calibrationStart == null) {
    fail("uncontested upgrade failed", calibrated.stderr, calibrationDirectory);
    return result;
  }
  const windowMs = Math.round(upgradeMs * WINDOW_MARGIN);

  for (let iteration = 0; iteration < iterations; iteration++) {
    run.checkDisk();
    const stage = KILL_STAGES[iteration % KILL_STAGES.length]!;
    const zinnDirectory = copyOlderStore(run, store, scenario);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");
    const killedKind = iteration % 2 === 0 ? ["task", "list", PROJECT_KEY] : ["migrate"];
    const nextArgs = iteration % 2 === 0 ? ["migrate"] : ["task", "list", PROJECT_KEY];
    const environment: Record<string, string> = {
      STRESS_EVENTS_FILE: eventsFile,
      STRESS_MIGRATION_SPILL_BYTES: String(KILL_SPILL_BYTES),
    };
    if (stage !== RANDOM_STAGE) {
      environment.STRESS_MIGRATION_PAUSE_AT = stage;
      environment.STRESS_MIGRATION_PAUSE_MS = String(KILL_PAUSE_MS);
    }

    try {
      const child = new Child(
        migratingCliCommand([...killedKind, "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        environment,
      );
      const reached = await waitForEvent(
        eventsFile,
        stage === RANDOM_STAGE ? "start" : stage,
        STAGE_WAIT_MS,
      );
      if (!reached) {
        child.kill();
        await child.exited;
        fail(
          "the migration never reached its stage",
          `iteration ${iteration}, stage ${stage}: ${child.stderr.trim()}`,
          zinnDirectory,
        );
        continue;
      }
      if (stage === RANDOM_STAGE) {
        await sleep(random.integer(0, windowMs));
      }

      const walPath = `${databasePathOf(zinnDirectory)}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      child.kill();
      await child.exited;
      result.iterations++;
      walAtKill.set(stage, [...(walAtKill.get(stage) ?? []), walBytes]);

      if (SPILLED_STAGES.includes(stage) && walBytes < MIN_SPILLED_WAL_BYTES) {
        fail(
          "no uncommitted pages in the -wal file",
          `iteration ${iteration}, stage ${stage}: the -wal file held ${formatBytes(walBytes)} at the kill, so the spill case was not tested`,
          zinnDirectory,
        );
      }

      // What the kill left, read from a copy of the files as they are: SQLite must recover from the -wal file alone.
      let committed = false;
      const imageProblems = checkCrashImage(run, zinnDirectory, (imagePath) =>
        withDatabase(imagePath, (db) => {
          const rows = readRows(db);
          committed = rows.version !== OLDER_VERSION;
          const found = [...checkZinnInvariants(db), ...checkSearchIndex(db, store.taskCount)];
          if (!committed) {
            found.push(...compareWithOlder(store.before, rows, false));
          }
          return found;
        }),
      );
      if (committed && stage !== RANDOM_STAGE) {
        imageProblems.push("the upgrade is committed although it was killed before its commit");
      }
      if (imageProblems.length > 0) {
        fail(
          "store after the kill is not the older store",
          `iteration ${iteration}, stage ${stage}: ${imageProblems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }

      // The backup was finished before the migration started and must be the older store.
      const backupsAfterKill = checkBackups(zinnDirectory, store.before);
      if (backupsAfterKill.names.length !== 1 || backupsAfterKill.problems.length > 0) {
        fail(
          "backup after the kill is not usable",
          `iteration ${iteration}, stage ${stage}: ${backupsAfterKill.names.length} backups ${backupsAfterKill.problems.slice(0, 5).join("; ")}`,
          zinnDirectory,
        );
      }

      // The next run, as the user would make it, upgrades from scratch or finds the commit already there.
      const next = await runToCompletion(
        migratingCliCommand([...nextArgs, "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        { STRESS_EVENTS_FILE: eventsFile },
      );
      if (next.exitCode !== 0) {
        fail(
          "the run after the kill failed",
          `iteration ${iteration}, stage ${stage}: ${errorMessageOf(next.stderr)}`,
          zinnDirectory,
        );
        continue;
      }

      const problems = checkUpgraded(zinnDirectory, store.before, false);
      const backups = checkBackups(zinnDirectory, store.before);
      const expectedStarts = committed ? 1 : 2;
      const starts = countMigrationStarts(eventsFile);
      if (starts !== expectedStarts) {
        problems.push(
          `the migration ran ${starts} times, expected ${expectedStarts}: the killed run's migration is not replayed, and the next run applies it once`,
        );
      }
      if (backups.names.length !== expectedStarts) {
        problems.push(
          `${backups.names.length} backups, expected ${expectedStarts}: ${backups.names.join(", ")}`,
        );
      }
      problems.push(...backups.problems);

      // A further command is a plain no-op for the schema: no new migration run, no new backup.
      const again = await runToCompletion(
        migratingCliCommand(["task", "list", PROJECT_KEY, "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        { STRESS_EVENTS_FILE: eventsFile },
      );
      if (
        again.exitCode !== 0 ||
        countMigrationStarts(eventsFile) !== expectedStarts ||
        checkBackups(zinnDirectory, store.before).names.length !== expectedStarts
      ) {
        problems.push(
          `a later command ran the migration or took a backup again, or failed: exit ${again.exitCode}`,
        );
      }

      if (problems.length > 0) {
        fail(
          "the run after the kill did not upgrade cleanly",
          `iteration ${iteration}, stage ${stage}: ${problems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }
      outcomes.push(`${stage}: ${committed ? "committed before the kill" : "rolled back"}`);
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  result.notes.push(
    `uncontested upgrade with a ${formatBytes(KILL_SPILL_BYTES)} spill ran ${upgradeMs} ms from its start; random kills spread over 0-${windowMs} ms after the migration starts`,
  );
  result.notes.push(
    `left by the kills: ${countBy(outcomes)
      .map(([outcome, count]) => `${count}x ${outcome}`)
      .join("; ")}`,
  );
  result.notes.push(
    `-wal file at the kill: ${[...walAtKill.entries()].map(([stage, sizes]) => `${stage} ${formatBytes(Math.min(...sizes))} to ${formatBytes(Math.max(...sizes))}`).join("; ")}`,
  );
  return result;
}

function allocatedBytes(path: string) {
  try {
    return (statSync(path).blocks ?? 0) * STAT_BLOCK_BYTES;
  } catch {
    return 0;
  }
}

function allocatedInDirectory(directory: string) {
  try {
    return readdirSync(directory).reduce(
      (total, name) => total + allocatedBytes(join(directory, name)),
      0,
    );
  } catch {
    return 0;
  }
}

type Allocation = { database: number; backup: number };
const ALLOCATION_KEYS = ["database", "backup"] as const;

/** Disk space in use right now: the database with its -wal and -shm files, and the backups. */
function readAllocation(zinnDirectory: string): Allocation {
  const databasePath = databasePathOf(zinnDirectory);

  return {
    database:
      allocatedBytes(databasePath) +
      allocatedBytes(`${databasePath}-wal`) +
      allocatedBytes(`${databasePath}-shm`),
    backup: allocatedInDirectory(backupDirectoryOf(zinnDirectory)),
  };
}

export async function runMigrateSizing(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-sizing";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });

  for (const taskCount of SIZING_STORE_TASKS) {
    const store = await olderStoreTemplate(
      run,
      taskCount,
      deriveSeed(options.seed, `${scenario}-store-${taskCount}`),
    );

    // The estimate the runner makes for this store: measured on a copy, before anything changes.
    const measuredDirectory = copyOlderStore(run, store, `${scenario}-measured`);
    const required = withDatabase(databasePathOf(measuredDirectory), (db) =>
      estimateRequiredFree(measureSpace(db, [STRESS_MIGRATION]), { includeBackup: true }),
    );
    run.remove(measuredDirectory);

    const zinnDirectory = copyOlderStore(run, store, scenario);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");

    try {
      const initial = readAllocation(zinnDirectory);
      const peak = { ...initial };
      const sample = () => {
        const now = readAllocation(zinnDirectory);
        for (const key of ALLOCATION_KEYS) {
          peak[key] = Math.max(peak[key], now[key]);
        }
      };
      const sampler = setInterval(sample, SAMPLE_INTERVAL_MS);

      const outcome = await runToCompletion(
        migratingCliCommand(["migrate", "--json"]),
        zinnDirectory,
        COMMAND_TIMEOUT_MS,
        {
          STRESS_EVENTS_FILE: eventsFile,
          STRESS_MIGRATION_PAUSE_AT: "before-commit",
          STRESS_MIGRATION_PAUSE_MS: String(SIZING_PAUSE_MS),
        },
      );
      clearInterval(sampler);
      sample();
      result.iterations++;

      if (outcome.exitCode !== 0) {
        fail(
          "upgrade failed",
          `${taskCount} tasks: ${errorMessageOf(outcome.stderr)}`,
          zinnDirectory,
        );
        continue;
      }

      const observed: Allocation = {
        database: peak.database - initial.database,
        backup: peak.backup - initial.backup,
      };
      const over = ALLOCATION_KEYS.filter((key) => observed[key] > required[key]);
      if (over.length > 0) {
        fail(
          "the upgrade took more disk space than the estimate",
          `${taskCount} tasks: ${over.map((key) => `${key} observed ${formatBytes(observed[key])}, estimate ${formatBytes(required[key])}`).join("; ")}`,
          zinnDirectory,
        );
      }

      const problems = checkUpgraded(zinnDirectory, store.before, false);
      if (problems.length > 0) {
        fail(
          "upgraded store is not intact",
          `${taskCount} tasks: ${problems.slice(0, 5).join("; ")}`,
          zinnDirectory,
        );
      }

      const describe = (key: keyof Allocation) =>
        `${key} ${formatBytes(observed[key])} of ${formatBytes(required[key])} (${required[key] === 0 ? "n/a" : `${Math.round((observed[key] / required[key]) * 100)}%`})`;
      result.notes.push(
        `${taskCount} tasks, ${formatBytes(initial.database)} database: observed of estimated, ${describe("database")}; ${describe("backup")}`,
      );
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  return result;
}

// The create race starts this many processes for every concurrent lane, as the first-use race in concurrency-cli does.
const CREATE_RACE_PROCESSES_PER_LANE = 2;
const CREATE_HOLD_MS = 300;

export async function runMigrateCreateRace(
  options: Options,
  run: RunDirectory,
  reproduce: string,
): Promise<ScenarioResult> {
  const scenario = "migrate-create-race";
  const result = createResult(scenario);
  const keep: Array<string> = [];
  const fail = failer({ scenario, reproduce, keep, result });
  const processCount = options.processes * CREATE_RACE_PROCESSES_PER_LANE;
  const durations: Array<number> = [];

  for (let round = 0; round < roundsFor(options); round++) {
    // The directory does not exist yet, so the first commands also race to create it and settings.json.
    const zinnDirectory = join(run.root, `${scenario}-${round}`);
    run.assertIsolated(zinnDirectory);
    const eventsDirectory = run.create(`${scenario}-events`);
    const eventsFile = join(eventsDirectory, "events.txt");
    const environment = {
      STRESS_EVENTS_FILE: eventsFile,
      STRESS_MIGRATION_PAUSE_AT: "rebuilt",
      STRESS_MIGRATION_PAUSE_MS: String(CREATE_HOLD_MS),
    };

    try {
      // Mostly creates, with some reads: every command on a missing store creates it first.
      const commands = Array.from({ length: processCount }, (_, index) =>
        index % 4 === 3
          ? { kind: "list", args: ["project", "list"] }
          : { kind: "create", args: ["project", "create", `P${index}`] },
      );
      const outcomes = await Promise.all(
        commands.map((command) =>
          runToCompletion(
            migratingCliCommand([...command.args, "--json"]),
            zinnDirectory,
            COMMAND_TIMEOUT_MS,
            environment,
          ),
        ),
      );
      result.iterations++;
      durations.push(...outcomes.map((outcome) => outcome.durationMs));

      const failed = outcomes.filter((outcome) => outcome.exitCode !== 0);
      if (failed.length > 0) {
        fail(
          "a command failed on first use",
          `round ${round}: ${countBy(failed.map((outcome) => errorMessageOf(outcome.stderr)))
            .map(([message, count]) => `${count}x ${message}`)
            .join("\n    ")}`,
          zinnDirectory,
        );
        continue;
      }

      const problems: Array<string> = [];
      const starts = countMigrationStarts(eventsFile);
      if (starts !== 1) {
        problems.push(
          `the migration chain ran ${starts} times, so ${starts === 0 ? "nobody" : "more than one process"} created the store`,
        );
      }
      if (
        existsSync(backupDirectoryOf(zinnDirectory)) &&
        readdirSync(backupDirectoryOf(zinnDirectory)).length > 0
      ) {
        problems.push(
          `creating a store took a backup: ${readdirSync(backupDirectoryOf(zinnDirectory)).join(", ")}`,
        );
      }
      const noisy = outcomes.filter((outcome) => outcome.stderr.trim() !== "");
      if (noisy.length > 0) {
        problems.push(
          `${noisy.length} processes printed on stderr, first: ${noisy[0]!.stderr.trim().slice(0, 200)}`,
        );
      }
      const settings = readFileSync(join(zinnDirectory, "settings.json"), "utf8");
      if (settings !== "{}\n") {
        problems.push(`settings.json holds ${JSON.stringify(settings)}`);
      }

      const acknowledged = commands.filter(
        (command, index) => command.kind === "create" && outcomes[index]!.exitCode === 0,
      ).length;
      problems.push(
        ...withDatabase(databasePathOf(zinnDirectory), (db) => {
          const found = checkZinnInvariants(db);
          const version = readSchemaVersion(db);
          const projects = db
            .query<{ count: number }>("SELECT COUNT(*) AS count FROM project")
            .get()!.count;
          if (version !== UPGRADED_VERSION) {
            found.push(`schema version is ${version}, expected ${UPGRADED_VERSION}`);
          }
          if (projects !== acknowledged) {
            found.push(`${acknowledged} project creates succeeded, ${projects} projects exist`);
          }
          return found;
        }),
      );

      if (problems.length > 0) {
        fail(
          "fresh store race went wrong",
          `round ${round}: ${problems.slice(0, 8).join("\n    ")}`,
          zinnDirectory,
        );
      }
    } finally {
      cleanUp(run, options, keep, [zinnDirectory, eventsDirectory]);
    }
  }

  const heldOthers = durations.filter((milliseconds) => milliseconds >= CREATE_HOLD_MS).length;
  result.notes.push(
    `${processCount} first commands at once on a missing directory, ${result.iterations} rounds; ${Math.round(heldOthers / result.iterations)} of ${processCount} processes per round took at least the ${CREATE_HOLD_MS} ms the creator held the lock`,
  );
  return result;
}
