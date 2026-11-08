/** Turns power samples and a block log into energy per command, with a drop rule. */

import { median } from "../zinn/stats.ts";
import type { BlockKind, BlockRow } from "./blocks.ts";
import { meanPowerMw, samplesInside, type PowerSample } from "./samples.ts";

/** Spread above this fraction means the figure is not stated. */
export const NOISY_SPREAD = 0.5;

/** An idle block above this many milliwatts marks its round as disturbed. */
export const MAXIMUM_IDLE_MW = 1_000;

/** A work block above this multiple of its workload's median marks its round as disturbed. */
export const WORK_SPIKE_FACTOR = 1.5;

/** Fewer clean rounds than this leaves the workload marked for a rerun. */
export const MINIMUM_CLEAN_ROUNDS = 4;

const MILLIJOULES_PER_MICRO_WATT_HOUR = 3.6;
const PERCENT = 100;
const DECIMAL_PLACES = 1;

export type DropReason = "idle" | "work";

export type DroppedBlock = {
  round: number;
  label: string;
  kind: BlockKind;
  reason: DropReason;
  observedMw: number;
  limitMw: number;
};

export type BlockAnalysis = {
  round: number;
  label: string;
  kind: BlockKind;
  start: number;
  end: number;
  count: number;
  /** Duration-weighted power over this block's own window, when it has samples. */
  averageMw?: number;
  /** Work blocks only: the paired idle block's duration-weighted power. */
  idleMw?: number;
  /** Work blocks only: milliseconds of samples that fell inside the block. */
  workSeconds?: number;
  /** Work blocks only: energy over the counted work samples. */
  workMj?: number;
  netMj?: number;
  perRunMj?: number;
  /** Why this block could not be paired with samples, when it could not. */
  skipped?: string;
  dropped: boolean;
  dropReason?: DropReason;
};

export type WorkloadAnalysis = {
  label: string;
  runsPerBlock: number;
  medianMj: number;
  minMj: number;
  maxMj: number;
  medianMicroWattHours: number;
  spread: number;
  verdict: "ok" | "noisy";
  cleanMedianMj: number | undefined;
  cleanMinMj: number | undefined;
  cleanMaxMj: number | undefined;
  cleanSpread: number | undefined;
  cleanRounds: number;
  cleanVerdict: "ok" | "rerun";
};

export type Analysis = {
  sampleCount: number;
  medianIntervalSeconds: number;
  idleMedianMw: number;
  idleMinMw: number;
  idleMaxMw: number;
  blocks: BlockAnalysis[];
  workloads: WorkloadAnalysis[];
  droppedBlocks: DroppedBlock[];
  droppedRounds: number[];
};

type WorkPair = {
  blockIndex: number;
  block: BlockRow;
  idle: BlockRow;
  idleMw: number;
  workAverageMw: number;
  workSeconds: number;
  workMj: number;
  netMj: number;
  perRunMj: number;
};

export function analyze(
  samples: readonly PowerSample[],
  blocks: readonly BlockRow[],
): Analysis {
  if (samples.length === 0) {
    throw new Error("no usable samples: processor.combined_power missing from the log");
  }
  const analyses = blocks.map((block) => baseAnalysis(block));
  const pairs = pairBlocks(samples, blocks, analyses);
  if (pairs.length === 0) {
    throw new Error("no work block has samples: nothing to analyze");
  }
  const idlePowers = pairs.map((pair) => pair.idleMw);

  for (const pair of pairs) {
    const analysis = analyses[pair.blockIndex]!;
    analysis.averageMw = pair.workAverageMw;
    analysis.idleMw = pair.idleMw;
    analysis.workSeconds = pair.workSeconds;
    analysis.workMj = pair.workMj;
    analysis.netMj = pair.netMj;
    analysis.perRunMj = pair.perRunMj;
  }

  const workloadMedians = medianWorkPower(pairs);
  const dropped = findDroppedBlocks(blocks, analyses, workloadMedians);
  const droppedRounds = new Set(dropped.map((entry) => entry.round));
  for (const block of analyses) {
    const reason = dropped.find(
      (entry) =>
        entry.round === block.round &&
        entry.label === block.label &&
        entry.kind === block.kind,
    );
    block.dropped = droppedRounds.has(block.round);
    if (reason !== undefined) {
      block.dropReason = reason.reason;
    }
  }

  return {
    sampleCount: samples.length,
    medianIntervalSeconds: median(samples.map((sample) => sample.seconds)),
    idleMedianMw: median(idlePowers),
    idleMinMw: Math.min(...idlePowers),
    idleMaxMw: Math.max(...idlePowers),
    blocks: analyses,
    workloads: summarize(pairs, droppedRounds),
    droppedBlocks: dropped,
    droppedRounds: [...droppedRounds].sort((left, right) => left - right),
  };
}

function baseAnalysis(block: BlockRow): BlockAnalysis {
  return {
    round: block.round,
    label: block.label,
    kind: block.kind,
    start: block.start,
    end: block.end,
    count: block.count,
    dropped: false,
  };
}

/** Pairs each work block with the idle block immediately before it and computes its energy. */
function pairBlocks(
  samples: readonly PowerSample[],
  blocks: readonly BlockRow[],
  analyses: BlockAnalysis[],
): WorkPair[] {
  const pairs: WorkPair[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const analysis = analyses[index]!;
    const average = meanPowerMw(samples, block.start, block.end);
    if (average !== undefined) {
      analysis.averageMw = average;
    }
    if (block.kind !== "work") {
      continue;
    }
    const idle = blocks[index - 1];
    if (idle === undefined || idle.kind !== "idle") {
      analysis.skipped = "no idle block before the work block";
      continue;
    }
    const idleMw = meanPowerMw(samples, idle.start, idle.end);
    if (idleMw === undefined) {
      analysis.skipped = "no samples in the idle window";
      continue;
    }
    const workSamples = samplesInside(samples, block.start, block.end);
    if (workSamples.length === 0) {
      analysis.skipped = "no samples in the work window";
      continue;
    }
    if (block.count <= 0) {
      throw new Error(`Block ${block.round} ${block.label} ran no commands`);
    }
    let workSeconds = 0;
    let workMj = 0;
    for (const sample of workSamples) {
      workSeconds += sample.seconds;
      workMj += sample.powerMw * sample.seconds;
    }
    const workAverageMw = workMj / workSeconds;
    // Scale to the block's full length, since partial samples at its edges are excluded.
    const durationSeconds = block.end - block.start;
    const netMj = (workMj - idleMw * workSeconds) * (durationSeconds / workSeconds);
    pairs.push({
      blockIndex: index,
      block,
      idle,
      idleMw,
      workAverageMw,
      workSeconds,
      workMj,
      netMj,
      perRunMj: netMj / block.count,
    });
  }
  return pairs;
}

function medianWorkPower(pairs: readonly WorkPair[]): Map<string, number> {
  const byLabel = new Map<string, number[]>();
  for (const pair of pairs) {
    const values = byLabel.get(pair.block.label) ?? [];
    values.push(pair.workAverageMw);
    byLabel.set(pair.block.label, values);
  }
  const medians = new Map<string, number>();
  for (const [label, values] of byLabel) {
    medians.set(label, median(values));
  }
  return medians;
}

/**
 * Drops a whole round from its first disturbed block, in the round's own block order.
 * The comparison uses every round's work power for the workload, candidate included.
 */
function findDroppedBlocks(
  blocks: readonly BlockRow[],
  analyses: readonly BlockAnalysis[],
  workloadMedians: ReadonlyMap<string, number>,
): DroppedBlock[] {
  const dropped: DroppedBlock[] = [];
  const rounds = [...new Set(blocks.map((block) => block.round))].sort(
    (left, right) => left - right,
  );
  for (const round of rounds) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.round !== round) {
        continue;
      }
      const average = analyses[index]!.averageMw;
      if (average === undefined) {
        continue;
      }
      if (block.kind === "idle" && average > MAXIMUM_IDLE_MW) {
        dropped.push({
          round,
          label: block.label,
          kind: block.kind,
          reason: "idle",
          observedMw: average,
          limitMw: MAXIMUM_IDLE_MW,
        });
        break;
      }
      if (block.kind === "work") {
        const workloadMedian = workloadMedians.get(block.label);
        if (workloadMedian === undefined) {
          continue;
        }
        const limit = workloadMedian * WORK_SPIKE_FACTOR;
        if (average > limit) {
          dropped.push({
            round,
            label: block.label,
            kind: block.kind,
            reason: "work",
            observedMw: average,
            limitMw: limit,
          });
          break;
        }
      }
    }
  }
  return dropped;
}

function summarize(
  pairs: readonly WorkPair[],
  droppedRounds: ReadonlySet<number>,
): WorkloadAnalysis[] {
  const byLabel = new Map<string, WorkPair[]>();
  for (const pair of pairs) {
    const values = byLabel.get(pair.block.label) ?? [];
    values.push(pair);
    byLabel.set(pair.block.label, values);
  }
  const workloads: WorkloadAnalysis[] = [];
  for (const [label, values] of byLabel) {
    const all = values.map((pair) => pair.perRunMj);
    const clean = values
      .filter((pair) => !droppedRounds.has(pair.block.round))
      .map((pair) => pair.perRunMj);
    const allStats = describe(all);
    workloads.push({
      label,
      runsPerBlock: Math.round(median(values.map((pair) => pair.block.count))),
      medianMj: allStats.median,
      minMj: allStats.min,
      maxMj: allStats.max,
      medianMicroWattHours: allStats.median / MILLIJOULES_PER_MICRO_WATT_HOUR,
      spread: allStats.spread,
      verdict: allStats.spread > NOISY_SPREAD ? "noisy" : "ok",
      cleanMedianMj: clean.length === 0 ? undefined : describe(clean).median,
      cleanMinMj: clean.length === 0 ? undefined : Math.min(...clean),
      cleanMaxMj: clean.length === 0 ? undefined : Math.max(...clean),
      cleanSpread: clean.length === 0 ? undefined : describe(clean).spread,
      cleanRounds: clean.length,
      cleanVerdict: clean.length < MINIMUM_CLEAN_ROUNDS ? "rerun" : "ok",
    });
  }
  return workloads;
}

function describe(values: readonly number[]): { median: number; min: number; max: number; spread: number } {
  const middle = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    median: middle,
    min,
    max,
    spread: middle > 0 ? (max - min) / middle : Number.POSITIVE_INFINITY,
  };
}

export function formatAnalysis(analysis: Analysis): string[] {
  const lines: string[] = [];
  lines.push(
    `samples: ${analysis.sampleCount}, median interval ${analysis.medianIntervalSeconds.toFixed(3)} s`,
  );
  lines.push(
    `idle power: median ${Math.round(analysis.idleMedianMw)} mW, range ${Math.round(analysis.idleMinMw)} to ${Math.round(analysis.idleMaxMw)} mW`,
  );
  lines.push("");
  lines.push(formatDropped(analysis.droppedBlocks));
  lines.push("");
  lines.push(
    [
      "command",
      "runs/block",
      "median mJ",
      "min mJ",
      "max mJ",
      "median uWh",
      "spread",
      "verdict",
      "clean median mJ",
      "clean rounds",
      "clean verdict",
    ].join("\t"),
  );
  for (const workload of analysis.workloads) {
    lines.push(
      [
        workload.label,
        String(workload.runsPerBlock),
        workload.medianMj.toFixed(DECIMAL_PLACES),
        workload.minMj.toFixed(DECIMAL_PLACES),
        workload.maxMj.toFixed(DECIMAL_PLACES),
        workload.medianMicroWattHours.toFixed(DECIMAL_PLACES),
        formatSpread(workload.spread),
        workload.verdict,
        formatOptional(workload.cleanMedianMj),
        String(workload.cleanRounds),
        workload.cleanVerdict,
      ].join("\t"),
    );
  }
  return lines;
}

function formatDropped(dropped: readonly DroppedBlock[]): string {
  if (dropped.length === 0) {
    return "dropped blocks: none";
  }
  const lines = [`dropped blocks: ${dropped.length}`];
  for (const entry of dropped) {
    const limit = `${Math.round(entry.limitMw)} mW`;
    lines.push(
      `  round ${entry.round} ${entry.label} (${entry.kind}): ${Math.round(entry.observedMw)} mW, limit ${limit}`,
    );
  }
  return lines.join("\n");
}

function formatSpread(spread: number): string {
  if (!Number.isFinite(spread)) {
    return "n/a";
  }
  return `${(spread * PERCENT).toFixed(0)}%`;
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(DECIMAL_PLACES);
}
