/**
 * Scenarios that SIGKILL one writer while it holds the write lock, with other writers running:
 *
 *   concurrency-kill-core   Bun processes running core operations on one project (task create,
 *                           shared-task comments, edits of their own tasks).
 *   concurrency-kill-mixed  Bun and Node wrapper-level writers on one file.
 *
 * Writers print LOCK <seq> right after BEGIN IMMEDIATE succeeds and then hold the lock for a few
 *  milliseconds. The parent kills a writer when it sees that line, restarts it, and measures how long
 *  the other writers take to commit again. Afterwards it checks acknowledged writes, whether the killed
 *  transaction left a trace, invariants, and every error a writer saw.
 */
import type { Database } from "../../../packages/core/src/sqlite/database.ts";
import type { Options, ScenarioResult } from "../harness.ts";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Child, cliCommand, CORE_WORKER, countBy, createResult, describeLatencies, percentile, RunDirectory, runToCompletion, sleep, WRAPPER_WORKER } from "../harness.ts";
import { createRandom, deriveSeed, type Random } from "../random.ts";
import { checkWrapperDatabase, readWorkerLog } from "../wrapper-checks.ts";
import { completeLines, CONTEND_PROJECT_KEY } from "../workload.ts";
import { checkZinnInvariants, withDatabase } from "../zinn-checks.ts";
import { runtimeCommand } from "./concurrency-mixed.ts";

const LANE_TIMEOUT_MS = 300_000;
// Kills are spaced so each one's recovery can be measured on its own.
const MIN_KILL_GAP_MS = 250;
const KILL_CHANCE_PER_LOCK = 0.2;
const POLL_MS = 50;
// A lane that keeps exiting on its own is broken; stop restarting it.
const MAX_UNEXPECTED_EXITS_PER_LANE = 5;
const DEADLINE_MS_PER_KILL = 3_000;
const MIN_DEADLINE_MS = 60_000;

type Lane = { name: string; command: (runNumber: number) => Array<string> };
type KillEvent = { lane: string; runNumber: number; seq: number; at: number };
type AckEvent = { lane: string; at: number; latencyMs: number };

/** Runs every lane, killing writers that announce the write lock, until the requested kills are done. */
async function runKillingLanes(lanes: Array<Lane>, directory: string, kills: number, random: Random) {
  const killEvents: Array<KillEvent> = [];
  const acks: Array<AckEvent> = [];
  const errors: Array<string> = [];
  const retries: Array<string> = [];
  const starts: Array<{ lane: string; runNumber: number }> = [];
  const running = new Map<string, Child>();
  let lastKillAt = -Infinity;
  let isStopping = false;

  async function runLane(lane: Lane) {
    let unexpectedExits = 0;

    for (let runNumber = 0; !isStopping; runNumber++) {
      const child = new Child(lane.command(runNumber), directory, LANE_TIMEOUT_MS);
      running.set(lane.name, child);
      starts.push({ lane: lane.name, runNumber });

      child.onLine((line, receivedAt) => {
        const [kind, first, ...rest] = line.split(" ");

        if (kind === "LOCK") {
          const isKillDue = !isStopping && killEvents.length < kills && receivedAt - lastKillAt >= MIN_KILL_GAP_MS;
          if (isKillDue && random.chance(KILL_CHANCE_PER_LOCK)) {
            child.kill();
            lastKillAt = performance.now();
            killEvents.push({ lane: lane.name, runNumber, seq: Number(first), at: lastKillAt });
          }
        } else if (kind === "ACK") {
          acks.push({ lane: lane.name, at: receivedAt, latencyMs: Number(rest[0]) });
        } else if (kind === "RETRY") {
          retries.push(`${first} ${rest.join(" ")}`);
        } else if (kind === "ERR" || kind === "INITERR") {
          errors.push(`${kind} ${first} ${rest.join(" ")}`);
        }
      });

      await child.exited;
      if (!child.wasKilled) {
        unexpectedExits++;
        errors.push(`${lane.name} exited ${child.process.exitCode}: ${child.stderr.trim().slice(0, 300)}`);
        if (unexpectedExits >= MAX_UNEXPECTED_EXITS_PER_LANE) {
          return;
        }
      }
    }
  }

  const laneRuns = lanes.map((lane) => runLane(lane));
  const deadline = performance.now() + Math.max(MIN_DEADLINE_MS, kills * DEADLINE_MS_PER_KILL);
  while (killEvents.length < kills && performance.now() < deadline) {
    await sleep(POLL_MS);
  }

  // Let the survivors of the last kill commit again before stopping, so its recovery is measured too.
  await sleep(MIN_KILL_GAP_MS);
  isStopping = true;
  for (const child of running.values()) {
    child.kill();
  }
  await Promise.all(laneRuns);

  return { killEvents, acks, errors, retries, starts };
}

/** How long after each kill the next commit by another writer arrived. */
function describeRecovery(killEvents: Array<KillEvent>, acks: Array<AckEvent>) {
  const stalls: Array<number> = [];
  let neverRecovered = 0;

  for (const kill of killEvents) {
    const next = acks.find((ack) => ack.lane !== kill.lane && ack.at > kill.at);
    if (next == null) {
      neverRecovered++;
    } else {
      stalls.push(next.at - kill.at);
    }
  }

  const gaps: Array<number> = [];
  const sortedAcks = [...acks].sort((a, b) => a.at - b.at);
  for (let index = 1; index < sortedAcks.length; index++) {
    gaps.push(sortedAcks[index]!.at - sortedAcks[index - 1]!.at);
  }
  const sortedGaps = gaps.sort((a, b) => a - b);

  return {
    text: `time from kill to the next commit by another writer: ${describeLatencies(stalls)}; ordinary gap between commits p50=${Math.round(percentile(sortedGaps, 0.5))}ms p99=${Math.round(percentile(sortedGaps, 0.99))}ms`,
    neverRecovered,
  };
}

export async function runConcurrencyKillCore(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const name = "concurrency-kill-core";
  const result = createResult(name);
  const zinnDirectory = run.create(name);
  const random = createRandom(deriveSeed(options.seed, name));
  let keepDirectory = false;
  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: name, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: zinnDirectory });
  };

  try {
    for (const args of [
      ["project", "create", CONTEND_PROJECT_KEY],
      ["task", "create", CONTEND_PROJECT_KEY, "--title", "shared"],
    ]) {
      const setup = await runToCompletion(cliCommand([...args, "--json"]), zinnDirectory, LANE_TIMEOUT_MS);
      if (setup.exitCode !== 0) {
        fail("setup failed", setup.stderr);
        return result;
      }
    }

    const lanes: Array<Lane> = Array.from({ length: options.processes }, (_, index) => {
      const laneName = `l${index}`;
      return {
        name: laneName,
        command: (runNumber) => [
          "bun", CORE_WORKER, "--mode", "contend", "--lane", laneName, "--run", String(runNumber),
          "--seed", String(deriveSeed(options.seed, `${name}-${laneName}-${runNumber}`)),
          "--log", join(zinnDirectory, `${laneName}.log`),
        ],
      };
    });

    run.assertIsolated(zinnDirectory);
    const { killEvents, acks, errors } = await runKillingLanes(lanes, zinnDirectory, options.kills, random);
    result.iterations = killEvents.length;

    const problems = withDatabase(join(zinnDirectory, "data", "zinn.sqlite"), (db) => {
      const found = checkZinnInvariants(db);
      let killedPresent = 0;
      let committedUnacknowledged = 0;

      for (const lane of lanes) {
        const logPath = join(zinnDirectory, `${lane.name}.log`);
        const entries = existsSync(logPath) ? completeLines(readFileSync(logPath, "utf8")).map((line) => JSON.parse(line)) : [];
        const acknowledged = new Set(entries.filter((entry) => entry.t === "ack").map((entry) => entry.marker as string));

        for (const entry of entries.filter((candidate) => candidate.t === "begin")) {
          const present = isCoreWritePresent(db, entry.op, `${entry.marker} ${entry.op}`);
          if (acknowledged.has(entry.marker) && !present) {
            found.push(`acknowledged ${entry.op} ${entry.marker} is missing`);
          }
          if (!acknowledged.has(entry.marker) && present) {
            committedUnacknowledged++;
          }
        }
      }

      for (const kill of killEvents) {
        const marker = `${kill.lane}r${kill.runNumber}s${kill.seq}`;
        const begin = findBegin(zinnDirectory, kill.lane, marker);
        if (begin != null && isCoreWritePresent(db, begin.op, `${marker} ${begin.op}`)) {
          killedPresent++;
        }
      }

      found.push(...checkFinalTitles(db));
      result.notes.push(
        `${killEvents.length} kills while holding the write lock; ${killedPresent} of the killed transactions were present afterwards (kill landed after commit); ${committedUnacknowledged} unacknowledged writes present in total`,
      );
      return found;
    });

    const recovery = describeRecovery(killEvents, acks);
    result.notes.push(`${acks.length} commits by ${options.processes} writers; commit latency ${describeLatencies(acks.map((ack) => ack.latencyMs))}`);
    result.notes.push(recovery.text);

    if (killEvents.length < options.kills) {
      fail("not enough kills", `only ${killEvents.length} of ${options.kills} kills happened before the deadline`);
    }
    if (recovery.neverRecovered > 0) {
      fail("writers did not recover", `${recovery.neverRecovered} kill(s) were not followed by any commit from another writer`);
    }
    if (errors.length > 0) {
      fail("errors reached a writer", countBy(errors).map(([message, count]) => `${count}x ${message}`).slice(0, 10).join("\n    "));
    }
    if (problems.length > 0) {
      fail("lost writes or invariants violated", problems.slice(0, 10).join("\n    "));
    }
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(zinnDirectory);
    }
  }

  return result;
}

function findBegin(zinnDirectory: string, lane: string, marker: string) {
  const logPath = join(zinnDirectory, `${lane}.log`);
  if (!existsSync(logPath)) {
    return null;
  }

  return (
    completeLines(readFileSync(logPath, "utf8"))
      .map((line) => JSON.parse(line))
      .find((entry) => entry.t === "begin" && entry.marker === marker) ?? null
  );
}

/** Whether a contend worker's write is in the database, by the unique text it wrote. */
function isCoreWritePresent(db: Database, operation: string, text: string) {
  if (operation === "create") {
    return (
      db
        .query<{ id: string }, [string]>(`SELECT activity.entity_id AS id FROM activity JOIN task ON task.id = activity.entity_id
        WHERE activity.entity_type = 'task' AND activity.action = 'create' AND json_extract(activity.changes, '$.title') = ?`)
        .get(text) != null
    );
  }

  if (operation === "comment") {
    return db.query<{ id: string }, [string]>("SELECT id FROM comment WHERE text = ?").get(text) != null;
  }

  return (
    db
      .query<{ id: string }, [string]>(`SELECT id FROM activity
      WHERE entity_type = 'task' AND action = 'edit' AND json_extract(changes, '$.title[1]') = ?`)
      .get(text) != null
  );
}

/** Each task's title must be the one its last committed edit (or its creation) recorded. */
function checkFinalTitles(db: Database) {
  const mismatches = db
    .query<{ id: string; title: string; recorded: string | null }>(`SELECT task.id, task.title,
      COALESCE(
        (SELECT json_extract(changes, '$.title[1]') FROM activity
          WHERE entity_type = 'task' AND entity_id = task.id AND action = 'edit' AND json_extract(changes, '$.title') IS NOT NULL
          ORDER BY rowid DESC LIMIT 1),
        (SELECT json_extract(changes, '$.title') FROM activity
          WHERE entity_type = 'task' AND entity_id = task.id AND action = 'create')
      ) AS recorded
    FROM task`)
    .all()
    .filter((row) => row.title !== row.recorded);

  return mismatches.map((row) => `task ${row.id}: title ${JSON.stringify(row.title)}, but its history ends at ${JSON.stringify(row.recorded)}`);
}

function describeRetries(retries: Array<string>) {
  if (retries.length === 0) {
    return "no startup retries";
  }

  return `startup retries absorbed by the getDb() policy: ${countBy(retries).map(([message, count]) => `${count}x ${message}`).join("; ")}`;
}

function workerName(lane: string, runNumber: number) {
  return `${lane}-r${runNumber}`;
}

export async function runConcurrencyKillMixed(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const name = "concurrency-kill-mixed";
  const result = createResult(name);
  const directory = run.create(name);
  const databasePath = join(directory, "wrapper.sqlite");
  const random = createRandom(deriveSeed(options.seed, name));
  // Writers run until the parent stops them.
  const unboundedTransactions = 1_000_000;
  let keepDirectory = false;
  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: name, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: directory });
  };

  try {
    const lanes: Array<Lane> = Array.from({ length: Math.max(2, options.processes) }, (_, index) => {
      const runtime: "bun" | "node" = index % 2 === 0 ? "bun" : "node";
      const laneName = `${runtime}-w${index}`;
      // Each restart is a new worker identity, so a killed transaction's sequence number is never reused.
      return {
        name: laneName,
        command: (runNumber) => [
          ...runtimeCommand(runtime), WRAPPER_WORKER, "--mode", "contend", "--db", databasePath,
          "--worker", workerName(laneName, runNumber),
          "--seed", String(deriveSeed(options.seed, `${name}-${laneName}-${runNumber}`)),
          "--log", join(directory, `${workerName(laneName, runNumber)}.log`),
          "--transactions", String(unboundedTransactions), "--announce-lock",
        ],
      };
    });

    run.assertIsolated(directory);
    const { killEvents, acks, errors, retries, starts } = await runKillingLanes(lanes, directory, options.kills, random);
    result.iterations = killEvents.length;

    const { problems, sequencesByWorker } = withDatabase(databasePath, (db) => checkWrapperDatabase(db));
    let committedUnacknowledged = 0;
    for (const start of starts) {
      const worker = workerName(start.lane, start.runNumber);
      const { acknowledged, begun } = readWorkerLog(join(directory, `${worker}.log`));
      const present = sequencesByWorker.get(worker) ?? new Set<number>();
      const lost = [...acknowledged].filter((seq) => !present.has(seq));
      const neverBegun = [...present].filter((seq) => !begun.has(seq));
      committedUnacknowledged += [...present].filter((seq) => !acknowledged.has(seq)).length;
      if (lost.length > 0) {
        problems.push(`${worker}: acknowledged transaction(s) missing: ${lost.slice(0, 5).join(", ")}`);
      }
      if (neverBegun.length > 0) {
        problems.push(`${worker}: transaction(s) present that were never begun: ${neverBegun.slice(0, 5).join(", ")}`);
      }
    }
    const killedPresent = killEvents.filter(
      (kill) => sequencesByWorker.get(workerName(kill.lane, kill.runNumber))?.has(kill.seq) === true,
    ).length;

    const recovery = describeRecovery(killEvents, acks);
    result.notes.push(
      `${killEvents.length} kills while holding the write lock; ${killedPresent} of the killed transactions were present afterwards; ${committedUnacknowledged} unacknowledged transactions present in total`,
    );
    result.notes.push(`${acks.length} commits; commit latency ${describeLatencies(acks.map((ack) => ack.latencyMs))}`);
    result.notes.push(describeRetries(retries));
    result.notes.push(recovery.text);

    if (killEvents.length < options.kills) {
      fail("not enough kills", `only ${killEvents.length} of ${options.kills} kills happened before the deadline`);
    }
    if (recovery.neverRecovered > 0) {
      fail("writers did not recover", `${recovery.neverRecovered} kill(s) were not followed by any commit from another writer`);
    }
    if (errors.length > 0) {
      fail("errors reached a writer", countBy(errors).map(([message, count]) => `${count}x ${message}`).slice(0, 10).join("\n    "));
    }
    if (problems.length > 0) {
      fail("lost writes or invariants violated", problems.slice(0, 10).join("\n    "));
    }
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(directory);
    }
  }

  return result;
}
