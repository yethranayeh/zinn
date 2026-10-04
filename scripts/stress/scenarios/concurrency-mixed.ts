/**
 * Scenario concurrency-mixed: Bun and Node wrapper-level writers on one database file at the same time.
 * They run different SQLite builds (Bun uses the system SQLite on macOS, Node bundles its own), so this
 *  checks that the two share WAL locking and the -shm index correctly.
 * Writers reopen their connection every few transactions, like short-lived CLI processes; readers
 *  check the balance total inside read transactions the whole time.
 *
 * Checks: every acknowledged transaction is present and no failed one is, all-or-nothing balances,
 *  no rolled-back savepoint rows, readers never see a half-applied transaction, errors that got
 *  through the busy timeout, and transaction latency.
 */
import type { Options, ScenarioResult } from "../harness.ts";

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Child, countBy, createResult, describeLatencies, NODE_COMMAND, RunDirectory, WRAPPER_WORKER } from "../harness.ts";
import { deriveSeed } from "../random.ts";
import { checkWrapperDatabase, readWorkerLog } from "../wrapper-checks.ts";
import { withDatabase } from "../zinn-checks.ts";

const SCENARIO = "concurrency-mixed";
const WORKER_TIMEOUT_MS = 300_000;
const READERS_PER_RUNTIME = 1;

export function runtimeCommand(runtime: "bun" | "node") {
  return runtime === "bun" ? ["bun"] : NODE_COMMAND;
}

export async function runConcurrencyMixed(options: Options, run: RunDirectory, reproduce: string): Promise<ScenarioResult> {
  const result = createResult(SCENARIO);
  const directory = run.create(SCENARIO);
  const databasePath = join(directory, "wrapper.sqlite");
  const stopFile = join(directory, "stop");
  let keepDirectory = false;
  const fail = (kind: string, detail: string) => {
    keepDirectory = true;
    result.failures.push({ scenario: SCENARIO, kind, detail: `${detail}\n    reproduce: ${reproduce}`, keptDirectory: directory });
  };

  try {
    const writerCount = Math.max(2, options.processes);
    const writers = Array.from({ length: writerCount }, (_, index) => {
      const runtime: "bun" | "node" = index % 2 === 0 ? "bun" : "node";
      const name = `${runtime}-w${index}`;
      const logPath = join(directory, `${name}.log`);
      const command = [
        ...runtimeCommand(runtime), WRAPPER_WORKER, "--mode", "contend", "--db", databasePath, "--worker", name,
        "--seed", String(deriveSeed(options.seed, `${SCENARIO}-${name}`)), "--log", logPath,
        "--transactions", String(options.transactions),
      ];
      return { name, runtime, logPath, child: new Child(command, directory, WORKER_TIMEOUT_MS) };
    });

    const readers = (["bun", "node"] as const).flatMap((runtime) =>
      Array.from({ length: READERS_PER_RUNTIME }, (_, index) => {
        const name = `${runtime}-r${index}`;
        const command = [
          ...runtimeCommand(runtime), WRAPPER_WORKER, "--mode", "read", "--db", databasePath, "--worker", name,
          "--seed", String(deriveSeed(options.seed, `${SCENARIO}-${name}`)), "--stop-file", stopFile,
        ];
        return { name, runtime, child: new Child(command, directory, WORKER_TIMEOUT_MS) };
      }),
    );

    const began = performance.now();
    await Promise.all(writers.map((writer) => writer.child.exited));
    const elapsedSeconds = (performance.now() - began) / 1000;
    writeFileSync(stopFile, "");
    await Promise.all(readers.map((reader) => reader.child.exited));

    const latencies: Record<string, Array<number>> = { bun: [], node: [] };
    const errors: Array<string> = [];
    const retries: Array<string> = [];

    for (const participant of [...writers, ...readers]) {
      if (participant.child.timedOut || participant.child.process.exitCode !== 0) {
        errors.push(`${participant.name} exited ${participant.child.process.exitCode}${participant.child.timedOut ? " (watchdog)" : ""}: ${participant.child.stderr.trim().slice(0, 300)}`);
      }
      for (const line of participant.child.lines) {
        if (line.startsWith("ACK ")) {
          latencies[participant.runtime]!.push(Number(line.split(" ")[2]));
        } else if (line.startsWith("RETRY ")) {
          retries.push(line.slice("RETRY ".length));
        } else if (line.startsWith("ERR ") || line.startsWith("READBAD ")) {
          errors.push(`${participant.runtime} ${line}`);
        }
      }
    }
    result.iterations = latencies.bun!.length + latencies.node!.length;

    const { problems, sequencesByWorker } = withDatabase(databasePath, (db) => checkWrapperDatabase(db));
    for (const writer of writers) {
      const { acknowledged } = readWorkerLog(writer.logPath);
      const present = sequencesByWorker.get(writer.name) ?? new Set<number>();
      const lost = [...acknowledged].filter((seq) => !present.has(seq));
      const unacknowledged = [...present].filter((seq) => !acknowledged.has(seq));
      if (lost.length > 0) {
        problems.push(`${writer.name}: ${lost.length} acknowledged transaction(s) missing, e.g. ${lost.slice(0, 5).join(", ")}`);
      }
      if (unacknowledged.length > 0) {
        problems.push(`${writer.name}: ${unacknowledged.length} transaction(s) present that reported an error, e.g. ${unacknowledged.slice(0, 5).join(", ")}`);
      }
    }

    if (errors.length > 0) {
      fail("errors got through to a writer or reader", countBy(errors).map(([message, count]) => `${count}x ${message}`).slice(0, 10).join("\n    "));
    }
    if (problems.length > 0) {
      fail("lost writes or invariants violated", problems.slice(0, 10).join("\n    "));
    }

    const readCounts = readers.map((reader) => reader.child.lines.find((line) => line.startsWith("DONE"))?.split("=")[1] ?? "?");
    result.notes.push(
      `${writerCount} writers (${writers.filter((writer) => writer.runtime === "bun").length} Bun, ${writers.filter((writer) => writer.runtime === "node").length} Node), ${result.iterations} transactions in ${elapsedSeconds.toFixed(1)} s; readers completed ${readCounts.join(" + ")} read transactions`,
    );
    result.notes.push(
      retries.length === 0
        ? "no startup retries"
        : `startup retries absorbed by the getDb() policy: ${countBy(retries).map(([message, count]) => `${count}x ${message}`).join("; ")}`,
    );
    result.notes.push(`Bun transaction latency ${describeLatencies(latencies.bun!)}`);
    result.notes.push(`Node transaction latency ${describeLatencies(latencies.node!)}`);
  } finally {
    if (!keepDirectory && !options.keep) {
      run.remove(directory);
    }
  }

  return result;
}
