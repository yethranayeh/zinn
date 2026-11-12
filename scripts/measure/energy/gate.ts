/** Waits for a quiet machine before each block and finds blocks that background work disturbed. */

import type { SessionSample } from "../quiet-session/sampler.ts";
import type { BlockKind, BlockRow } from "./blocks.ts";

/**
 * A one-minute load average above this means the machine is busy.
 * Two clean quiet sessions on an M4 MacBook Pro stayed below 3.1, a normal desktop with apps open sat near 4.4.
 */
export const QUIET_LOAD = 3.5;

/** The longest wait for a quiet machine before one block. */
export const QUIET_WAIT_LIMIT_SECONDS = 60;

const QUIET_POLL_SECONDS = 5;

/** A named background process at or above this CPU share disturbs the block it falls in. */
export const NOISY_PROCESS_CPU_PERCENT = 20;

/** Background services known to wake up on an idle Mac: indexing, backups, photo and Siri analysis, updates. */
const NOISY_PROCESSES = [
  /^mds$/,
  /^mds_stores$/,
  /^mdworker/,
  /^backupd$/,
  /^photoanalysisd$/,
  /^softwareupdated$/,
  /^siriknowledged$/,
  /^contactsd$/,
  /^suggestd$/,
];

const MILLISECONDS_PER_SECOND = 1_000;

export type QuietWait = {
  round: number;
  label: string;
  loadBefore: number;
  loadAfter: number;
  waitedSeconds: number;
  /** True when the load was still high at the limit and the block ran anyway. */
  timedOut: boolean;
};

export type ContaminationReason = "load" | "process";

export type ContaminatedBlock = {
  round: number;
  label: string;
  kind: BlockKind;
  reason: ContaminationReason;
  /** The load average, or the process's CPU percent. */
  observed: number;
  limit: number;
  /** The process name, for a process reason. */
  process?: string;
};

export async function waitForQuiet(options: {
  round: number;
  label: string;
  readLoad: () => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<QuietWait | undefined> {
  const loadBefore = await options.readLoad();
  if (loadBefore <= QUIET_LOAD) {
    return undefined;
  }
  let load = loadBefore;
  let waitedSeconds = 0;
  while (load > QUIET_LOAD && waitedSeconds < QUIET_WAIT_LIMIT_SECONDS) {
    await options.sleep(QUIET_POLL_SECONDS * MILLISECONDS_PER_SECOND);
    waitedSeconds += QUIET_POLL_SECONDS;
    load = await options.readLoad();
  }
  return {
    round: options.round,
    label: options.label,
    loadBefore,
    loadAfter: load,
    waitedSeconds,
    timedOut: load > QUIET_LOAD,
  };
}

/** One entry per disturbed block, with the first reason found in the block's samples. */
export function findContaminatedBlocks(
  samples: readonly SessionSample[],
  blocks: readonly BlockRow[],
): ContaminatedBlock[] {
  const contaminated: ContaminatedBlock[] = [];
  for (const block of blocks) {
    const inside = samples.filter(
      (sample) => sample.seconds >= block.start && sample.seconds <= block.end,
    );
    const reason = firstReason(inside);
    if (reason !== undefined) {
      contaminated.push({ round: block.round, label: block.label, kind: block.kind, ...reason });
    }
  }
  return contaminated;
}

function firstReason(
  samples: readonly SessionSample[],
): Pick<ContaminatedBlock, "reason" | "observed" | "limit" | "process"> | undefined {
  for (const sample of samples) {
    if (sample.load1 > QUIET_LOAD) {
      return { reason: "load", observed: sample.load1, limit: QUIET_LOAD };
    }
    for (const entry of sample.processes) {
      const name = entry.command.split("/").pop() ?? entry.command;
      const isNoisy = NOISY_PROCESSES.some((pattern) => pattern.test(name));
      if (isNoisy && entry.cpuPercent >= NOISY_PROCESS_CPU_PERCENT) {
        return {
          reason: "process",
          observed: entry.cpuPercent,
          limit: NOISY_PROCESS_CPU_PERCENT,
          process: name,
        };
      }
    }
  }
  return undefined;
}
