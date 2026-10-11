/**
 * Crash and concurrency harness for Zinn's SQLite layer. Slow, so it is not part of `bun test`.
 *
 *   bun run test:stress                                  every scenario, default sizes, random seed
 *   bun run test:stress --scenario crash-core --seed 42  one scenario, fixed seed
 *   bun run test:stress --kills 150 --processes 10       a longer run
 *
 * Options:
 *   --scenario <name>[,<name>...]  default: all (see SCENARIOS below)
 *   --seed <n>                     fixes the operation mix and kill schedule; OS scheduling still varies
 *   --kills <n>                    SIGKILLs per crash scenario and per kill scenario (default 30); also scales
 *                                  the migrate-* scenarios' rounds (one per 6) and migrate-kill iterations (one per 3)
 *   --processes <n>                concurrent processes in the concurrency and migrate-* scenarios (default 6)
 *   --commands <n>                 CLI commands per process in concurrency-cli (default 20)
 *   --transactions <n>             transactions per writer in concurrency-mixed (default 300)
 *   --seed-tasks <n>               tasks in the database crash-backup interrupts (default 3000)
 *   --dir <path>                   where the run directory goes (default: the OS temp directory)
 *   --keep                         keep the run directory even when everything passes
 *
 * Every child process gets an explicit ZINN_DIR inside the run directory; the harness refuses to run
 *  anywhere near ~/.zinn or ~/.zinn-backups. Core operations need Bun (Node cannot resolve
 *  core's extensionless source imports), so only the wrapper scenarios run under Node.
 */
import type { Options, ScenarioResult } from "./harness.ts";

import { randomInt } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { openDatabase } from "../../packages/core/src/sqlite/bun.ts";
import {
  DEFAULT_OPTIONS,
  NODE_COMMAND,
  reproduceCommand,
  RunDirectory,
  runToCompletion,
} from "./harness.ts";
import { runConcurrencyCli } from "./scenarios/concurrency-cli.ts";
import { runConcurrencyKillCore, runConcurrencyKillMixed } from "./scenarios/concurrency-kill.ts";
import { runConcurrencyMixed } from "./scenarios/concurrency-mixed.ts";
import { runCrashCore } from "./scenarios/crash-core.ts";
import { runCrashBackup, runCrashInit } from "./scenarios/crash-startup.ts";
import { runCrashWrapper } from "./scenarios/crash-wrapper.ts";
import {
  runMigrateCreateRace,
  runMigrateKill,
  runMigrateLockTimeout,
  runMigrateOpenRace,
  runMigrateRace,
  runMigrateSizing,
} from "./scenarios/migrations.ts";
import { runRestoreConcurrentWriter, runRestoreKill } from "./scenarios/restores.ts";

type Scenario = (
  options: Options,
  run: RunDirectory,
  reproduce: string,
) => Promise<ScenarioResult | Array<ScenarioResult>>;

const SCENARIOS: Record<string, Scenario> = {
  "crash-core": runCrashCore,
  "crash-init": runCrashInit,
  "crash-backup": runCrashBackup,
  "crash-wrapper": runCrashWrapper,
  "concurrency-cli": runConcurrencyCli,
  "concurrency-mixed": runConcurrencyMixed,
  "concurrency-kill-core": runConcurrencyKillCore,
  "concurrency-kill-mixed": runConcurrencyKillMixed,
  "migrate-open-race": runMigrateOpenRace,
  "migrate-race": runMigrateRace,
  "migrate-lock-timeout": runMigrateLockTimeout,
  "migrate-kill": runMigrateKill,
  "migrate-sizing": runMigrateSizing,
  "migrate-create-race": runMigrateCreateRace,
  "restore-kill": runRestoreKill,
  "restore-concurrent-writer": runRestoreConcurrentWriter,
};

const SEED_LIMIT = 2 ** 31;

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      seed: { type: "string" },
      kills: { type: "string" },
      processes: { type: "string" },
      commands: { type: "string" },
      transactions: { type: "string" },
      "seed-tasks": { type: "string" },
      dir: { type: "string" },
      keep: { type: "boolean" },
    },
    strict: true,
  });

  const scenarios = values.scenario == null ? Object.keys(SCENARIOS) : values.scenario.split(",");
  for (const scenario of scenarios) {
    if (SCENARIOS[scenario] == null) {
      throw new Error(
        `Unknown scenario "${scenario}". Known: ${Object.keys(SCENARIOS).join(", ")}`,
      );
    }
  }

  const number = (value: string | undefined, fallback: number) =>
    value == null ? fallback : Number(value);

  return {
    scenarios,
    seed: number(values.seed, randomInt(SEED_LIMIT)),
    kills: number(values.kills, DEFAULT_OPTIONS.kills),
    processes: number(values.processes, DEFAULT_OPTIONS.processes),
    commands: number(values.commands, DEFAULT_OPTIONS.commands),
    transactions: number(values.transactions, DEFAULT_OPTIONS.transactions),
    seedTasks: number(values["seed-tasks"], DEFAULT_OPTIONS.seedTasks),
    keep: values.keep ?? DEFAULT_OPTIONS.keep,
    baseDirectory: values.dir ?? DEFAULT_OPTIONS.baseDirectory,
  };
}

/** SQLite versions and the synchronous level each runtime ends up with in WAL mode. */
async function describeEnvironment(run: RunDirectory) {
  const directory = run.create("environment");
  const bunPath = join(directory, "bun.sqlite");
  const db = openDatabase(bunPath);
  db.exec("PRAGMA journal_mode = WAL");
  const bunVersion = db
    .query<{ version: string }>("SELECT sqlite_version() AS version")
    .get()!.version;
  const bunSynchronous = db.query<{ synchronous: number }>("PRAGMA synchronous").get()!.synchronous;
  db.close();

  const nodeScript = `const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(join(directory, "node.sqlite"))});
    db.exec("PRAGMA journal_mode = WAL");
    const version = db.prepare("SELECT sqlite_version() AS version").get().version;
    const synchronous = db.prepare("PRAGMA synchronous").get().synchronous;
    db.close();
    console.log(process.version + " " + version + " " + synchronous);`;
  const node = await runToCompletion([...NODE_COMMAND, "-e", nodeScript], directory, 30_000);
  const [nodeVersion, nodeSqlite, nodeSynchronous] = node.stdout.trim().split(" ");
  run.remove(directory);

  return `Bun ${Bun.version} / SQLite ${bunVersion} (synchronous=${bunSynchronous} in WAL); Node ${nodeVersion} / SQLite ${nodeSqlite} (synchronous=${nodeSynchronous} in WAL); ${process.platform} ${process.arch}`;
}

async function main() {
  const options = parseOptions();
  const run = new RunDirectory(options.baseDirectory, options.seed);
  const results: Array<ScenarioResult> = [];
  const began = performance.now();

  console.log(`seed ${options.seed}, run directory ${run.root}`);

  try {
    console.log(await describeEnvironment(run));

    for (const name of options.scenarios) {
      const scenarioBegan = performance.now();
      console.log(`\n== ${name}`);
      const outcome = await SCENARIOS[name]!(options, run, reproduceCommand(options, name));

      for (const result of Array.isArray(outcome) ? outcome : [outcome]) {
        results.push(result);
        const status = result.failures.length === 0 ? "ok" : `${result.failures.length} FAILURE(S)`;
        console.log(
          `${result.name}: ${result.iterations} iterations, ${status} (${((performance.now() - scenarioBegan) / 1000).toFixed(1)} s)`,
        );
        for (const note of result.notes) {
          console.log(`  ${note}`);
        }
        for (const failure of result.failures) {
          console.log(`  FAILURE [${failure.kind}]\n    ${failure.detail}`);
          if (failure.keptDirectory != null) {
            console.log(`    kept for inspection: ${failure.keptDirectory}`);
          }
        }
      }
    }
  } finally {
    const failures = results.flatMap((result) => result.failures);
    const keepsAnything = options.keep || failures.some((failure) => failure.keptDirectory != null);

    console.log(
      `\n== summary (seed ${options.seed}, ${((performance.now() - began) / 1000).toFixed(0)} s)`,
    );
    for (const result of results) {
      const kinds = [...new Set(result.failures.map((failure) => failure.kind))].join("; ");
      console.log(
        `${result.name.padEnd(24)} ${String(result.iterations).padStart(6)} iterations  ${result.failures.length} failures${kinds ? `  (${kinds})` : ""}`,
      );
    }

    if (keepsAnything) {
      console.log(`\nrun directory kept: ${run.root}`);
    } else {
      run.removeRoot();
    }

    process.exitCode = failures.length > 0 ? 1 : 0;
  }
}

await main();
