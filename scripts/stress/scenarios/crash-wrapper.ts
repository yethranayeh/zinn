/**
 * Scenario crash-wrapper: SIGKILL a wrapper-level writer (wrapper-worker.ts, crash mode) under Bun and
 *  under Node. The workload commits transfers with nested savepoints, occasional large commits that
 *  span many WAL frames, TRUNCATE checkpoints, and close-and-reopen, so kills also land mid-checkpoint
 *  and mid-close.
 *
 * After each kill the parent checks a copy of the main file and WAL as the kill left them (no -shm):
 *  integrity, all-or-nothing balances, no rolled-back savepoint rows, every acknowledged transaction
 *  present, and at most the one in-flight transaction present without an acknowledgment.
 */
import type { Options, ScenarioResult } from "../harness.ts";

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Child, createResult, RunDirectory, sleep, WRAPPER_WORKER } from "../harness.ts";
import { createRandom, deriveSeed } from "../random.ts";
import { checkWrapperDatabase, readWorkerLog } from "../wrapper-checks.ts";
import { withDatabase } from "../zinn-checks.ts";
import { runtimeCommand } from "./concurrency-mixed.ts";

const SCENARIO = "crash-wrapper";
const WORKER_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const EARLY_KILL_CHANCE = 0.15;
const STARTUP_WINDOW_MS = 100;
const MAX_KILL_DELAY_MS = 150;

function copyCrashImage(databasePath: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  const target = join(destination, "wrapper.sqlite");

  copyFileSync(databasePath, target);
  if (existsSync(`${databasePath}-wal`)) {
    copyFileSync(`${databasePath}-wal`, `${target}-wal`);
  }

  return target;
}

async function runForRuntime(runtime: "bun" | "node", options: Options, run: RunDirectory, reproduce: string) {
  const result = createResult(`${SCENARIO}-${runtime}`);
  const directory = run.create(result.name);
  const databasePath = join(directory, "wrapper.sqlite");
  const logPath = join(directory, "acks.log");
  const worker = `${runtime}-crash`;
  const random = createRandom(deriveSeed(options.seed, result.name));
  // Transactions found committed without an acknowledgment: each one must be the tail at its kill.
  const committedUnacknowledged = new Set<number>();
  let acknowledgedCount = 0;
  let keepDirectory = false;
  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: result.name, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: directory });
  };

  try {
    for (let iteration = 0; iteration < options.kills; iteration++) {
      run.checkDisk();
      const command = [
        ...runtimeCommand(runtime), WRAPPER_WORKER, "--mode", "crash", "--db", databasePath, "--worker", worker,
        "--seed", String(deriveSeed(options.seed, `${result.name}-${iteration}`)), "--log", logPath,
      ];
      run.assertIsolated(directory);
      const child = new Child(command, directory, WORKER_TIMEOUT_MS);
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
      if (!existsSync(databasePath)) {
        continue;
      }

      const imageDirectory = join(directory, `image-${iteration}`);
      const imagePath = copyCrashImage(databasePath, imageDirectory);
      const { problems, sequencesByWorker } = withDatabase(imagePath, (db) => checkWrapperDatabase(db));
      const { acknowledged } = readWorkerLog(logPath);
      const present = sequencesByWorker.get(worker) ?? new Set<number>();
      const highest = [...present].reduce((maximum, seq) => Math.max(maximum, seq), 0);

      const lost = [...acknowledged].filter((seq) => !present.has(seq));
      if (lost.length > 0) {
        problems.push(`${lost.length} acknowledged transaction(s) missing, e.g. ${lost.slice(0, 5).join(", ")}`);
      }
      for (let seq = 1; seq <= highest; seq++) {
        if (!present.has(seq)) {
          problems.push(`transaction ${seq} is missing below the highest stored transaction ${highest}`);
          break;
        }
      }
      const newUnacknowledged = [...present].filter((seq) => !acknowledged.has(seq) && !committedUnacknowledged.has(seq));
      if (newUnacknowledged.length > 1 || (newUnacknowledged.length === 1 && newUnacknowledged[0] !== highest)) {
        problems.push(`unacknowledged transactions other than the in-flight one: ${newUnacknowledged.join(", ")}`);
      }
      for (const seq of newUnacknowledged) {
        committedUnacknowledged.add(seq);
      }

      if (problems.length > 0) {
        fail("crash image violates acknowledged state or invariants", `run ${iteration} (crash image kept at ${imageDirectory}):\n    ${problems.slice(0, 10).join("\n    ")}`);
        break;
      }
      run.remove(imageDirectory);
    }

    acknowledgedCount = readWorkerLog(logPath).acknowledged.size;
    if (result.failures.length === 0 && existsSync(databasePath)) {
      const { problems } = withDatabase(databasePath, (db) => checkWrapperDatabase(db));
      if (problems.length > 0) {
        fail("live database violates invariants after the last kill", problems.join("\n    "));
      }
    }
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(directory);
    }
  }

  result.notes.push(
    `${acknowledgedCount} acknowledged transactions across ${result.iterations} kills; ${committedUnacknowledged.size} kills landed after a commit but before its acknowledgment`,
  );
  return result;
}

export async function runCrashWrapper(options: Options, run: RunDirectory, reproduce: string) {
  return [
    await runForRuntime("bun", options, run, reproduce),
    await runForRuntime("node", options, run, reproduce),
  ];
}
