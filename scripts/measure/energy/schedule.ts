/** Runs shuffled rounds of idle and work blocks and records their exact times. */

import { createRandom } from "../../stress/random.ts";
import type { Runner } from "../quiet-session/runner.ts";
import { type BlockRow } from "./blocks.ts";

/** Fixed seed so every run has the same block order. */
export const SCHEDULE_SEED = 20261106;

const MILLISECONDS_PER_SECOND = 1_000;

export type WorkloadCommand = {
  argv: readonly string[];
  /** The environment for one measured command. */
  env: Record<string, string>;
  cwd?: string;
};

export type Workload = {
  /** Unique within one run, such as list@100 or node. */
  label: string;
  /** Prepares a fresh fixture copy and returns the command to run in the work phase. */
  prepare: () => Promise<WorkloadCommand>;
};

export type RunBlocksOptions = {
  workloads: readonly Workload[];
  rounds: number;
  idleSeconds: number;
  workSeconds: number;
  settleSeconds: number;
  runner: Runner;
  seed?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onBlock?: (row: BlockRow) => void | Promise<void>;
  onProgress?: (done: number, total: number, row: BlockRow) => void;
};

/** A seeded Fisher-Yates order for each round, stable for a given seed and label list. */
export function roundOrders(
  labels: readonly string[],
  rounds: number,
  seed: number = SCHEDULE_SEED,
): string[][] {
  const random = createRandom(seed);
  const orders: string[][] = [];
  for (let round = 0; round < rounds; round++) {
    const order = [...labels];
    for (let index = order.length - 1; index > 0; index--) {
      const swap = random.integer(0, index);
      const value = order[index]!;
      order[index] = order[swap]!;
      order[swap] = value;
    }
    orders.push(order);
  }
  return orders;
}

export async function runBlocks(options: RunBlocksOptions): Promise<BlockRow[]> {
  if (options.workloads.length === 0) {
    throw new Error("An energy run needs at least one workload");
  }
  const byLabel = new Map<string, Workload>();
  for (const workload of options.workloads) {
    if (byLabel.has(workload.label)) {
      throw new Error(`Two workloads share the label ${workload.label}`);
    }
    byLabel.set(workload.label, workload);
  }
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const orders = roundOrders(
    options.workloads.map((workload) => workload.label),
    options.rounds,
    options.seed,
  );
  const total = options.workloads.length * options.rounds;
  const rows: BlockRow[] = [];
  let done = 0;

  for (let round = 0; round < orders.length; round++) {
    for (const label of orders[round]!) {
      const workload = byLabel.get(label);
      if (workload === undefined) {
        throw new Error(`No workload for label ${label}`);
      }
      const command = await workload.prepare();
      await sleep(options.settleSeconds * MILLISECONDS_PER_SECOND);

      const idleStart = now();
      await sleep(options.idleSeconds * MILLISECONDS_PER_SECOND);
      const idleEnd = now();
      const idleRow: BlockRow = {
        round: round + 1,
        label,
        kind: "idle",
        start: toSeconds(idleStart),
        end: toSeconds(idleEnd),
        count: 0,
      };
      rows.push(idleRow);
      await options.onBlock?.(idleRow);

      const workStart = now();
      const deadline = workStart + options.workSeconds * MILLISECONDS_PER_SECOND;
      let count = 0;
      while (now() < deadline) {
        const result = await options.runner.capture(command.argv, {
          cwd: command.cwd,
          env: command.env,
          discardStdout: true,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `${label} stopped the run with exit code ${result.exitCode}:\n${result.stderr.trim()}`,
          );
        }
        count++;
      }
      const workEnd = now();
      if (count === 0) {
        throw new Error(`${label} finished no run inside its work phase`);
      }
      const workRow: BlockRow = {
        round: round + 1,
        label,
        kind: "work",
        start: toSeconds(workStart),
        end: toSeconds(workEnd),
        count,
      };
      rows.push(workRow);
      await options.onBlock?.(workRow);
      done++;
      options.onProgress?.(done, total, workRow);
    }
  }
  return rows;
}

function toSeconds(milliseconds: number): number {
  return Number((milliseconds / MILLISECONDS_PER_SECOND).toFixed(3));
}
