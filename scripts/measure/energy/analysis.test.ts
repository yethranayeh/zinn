import { expect, test } from "bun:test";

import {
  analyze,
  MAXIMUM_IDLE_MW,
  MINIMUM_CLEAN_ROUNDS,
  workloadsShortOfCleanRounds,
} from "./analysis.ts";
import type { BlockRow } from "./blocks.ts";
import { samplesInside, type PowerSample } from "./samples.ts";

function sample(startSeconds: number, powerMw: number, seconds = 1): PowerSample {
  return {
    startSeconds,
    endSeconds: startSeconds + seconds,
    powerMw,
    seconds,
    record: { processor: { combined_power: powerMw } },
  };
}

function secondsOf(startSeconds: number, count: number, powerMw: number): PowerSample[] {
  const samples: PowerSample[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(sample(startSeconds + index, powerMw));
  }
  return samples;
}

function pair(
  round: number,
  label: string,
  startSeconds: number,
  idlePowerMw: number,
  workPowerMw: number,
  count = 10,
): { samples: PowerSample[]; blocks: BlockRow[] } {
  return {
    samples: [
      ...secondsOf(startSeconds, 10, idlePowerMw),
      ...secondsOf(startSeconds + 10, 10, workPowerMw),
    ],
    blocks: [
      {
        round,
        label,
        kind: "idle",
        start: startSeconds,
        end: startSeconds + 10,
        count: 0,
      },
      {
        round,
        label,
        kind: "work",
        start: startSeconds + 10,
        end: startSeconds + 20,
        count,
      },
    ],
  };
}

test("a sample counts only when its whole interval is inside the block", () => {
  const samples = [sample(0, 100), sample(1, 200), sample(2, 300)];
  expect(samplesInside(samples, 0.5, 2.5)).toEqual([samples[1]!]);
  expect(samplesInside(samples, 1, 2)).toEqual([samples[1]!]);
  expect(samplesInside(samples, 1.001, 2)).toEqual([]);
});

test("energy per command subtracts idle power and divides by the run count", () => {
  const data = pair(1, "x", 0, 500, 1_500, 100);
  const analysis = analyze(data.samples, data.blocks);
  expect(analysis.idleMedianMw).toBe(500);
  expect(analysis.workloads).toHaveLength(1);
  const workload = analysis.workloads[0]!;
  expect(workload.medianMj).toBeCloseTo(100, 5);
  expect(workload.medianMicroWattHours).toBeCloseTo(100 / 3.6, 5);
  expect(workload.verdict).toBe("ok");
  expect(workload.cleanVerdict).toBe("rerun");
  expect(workload.cleanRounds).toBe(1);
});

test("an idle spike drops its whole round", () => {
  const data = [1, 2, 3, 4, 5].map((round) =>
    pair(round, "x", round * 100, round === 4 ? MAXIMUM_IDLE_MW + 500 : 400, 1_000),
  );
  const analysis = analyze(
    data.flatMap((entry) => entry.samples),
    data.flatMap((entry) => entry.blocks),
  );
  expect(analysis.droppedRounds).toEqual([4]);
  expect(analysis.droppedBlocks).toHaveLength(1);
  expect(analysis.droppedBlocks[0]!.reason).toBe("idle");
  expect(analysis.workloads[0]!.cleanRounds).toBe(MINIMUM_CLEAN_ROUNDS);
  expect(analysis.workloads[0]!.cleanVerdict).toBe("ok");
});

test("a work spike above 1.5 times the workload median drops its whole round", () => {
  const data = [1, 2, 3, 4, 5].map((round) =>
    pair(round, "x", round * 100, 400, round === 2 ? 2_000 : 1_000),
  );
  const analysis = analyze(
    data.flatMap((entry) => entry.samples),
    data.flatMap((entry) => entry.blocks),
  );
  expect(analysis.droppedRounds).toEqual([2]);
  expect(analysis.droppedBlocks[0]!.reason).toBe("work");
  expect(analysis.workloads[0]!.cleanRounds).toBe(4);
});

test("a clean run drops nothing", () => {
  const data = [1, 2, 3, 4, 5].map((round) => pair(round, "x", round * 100, 400, 1_000));
  const analysis = analyze(
    data.flatMap((entry) => entry.samples),
    data.flatMap((entry) => entry.blocks),
  );
  expect(analysis.droppedRounds).toEqual([]);
  expect(analysis.droppedBlocks).toEqual([]);
  expect(analysis.workloads[0]!.cleanRounds).toBe(5);
  expect(analysis.workloads[0]!.cleanMedianMj).toBeCloseTo(
    analysis.workloads[0]!.medianMj,
    5,
  );
});

test("fewer than four clean rounds marks the workload for a rerun", () => {
  const data = [1, 2, 3, 4, 5].map((round) =>
    pair(round, "x", round * 100, round === 2 || round === 5 ? 2_000 : 400, 1_000),
  );
  const analysis = analyze(
    data.flatMap((entry) => entry.samples),
    data.flatMap((entry) => entry.blocks),
  );
  expect(analysis.droppedRounds).toEqual([2, 5]);
  expect(analysis.workloads[0]!.cleanRounds).toBe(3);
  expect(analysis.workloads[0]!.cleanVerdict).toBe("rerun");
  expect(workloadsShortOfCleanRounds(analysis)).toEqual(["x"]);
});

test("a contaminated block drops its whole round", () => {
  const data = [1, 2, 3, 4, 5].map((round) => pair(round, "x", round * 100, 400, 1_000));
  const analysis = analyze(
    data.flatMap((entry) => entry.samples),
    data.flatMap((entry) => entry.blocks),
    [{ round: 3, label: "x", kind: "idle", reason: "load", observed: 5, limit: 3.5 }],
  );
  expect(analysis.droppedRounds).toEqual([3]);
  expect(analysis.droppedBlocks).toEqual([]);
  expect(analysis.contaminatedBlocks).toHaveLength(1);
  expect(analysis.blocks.find((block) => block.round === 3 && block.kind === "idle")?.contamination).toBe("load");
  expect(analysis.blocks.filter((block) => block.round === 3).every((block) => block.dropped)).toBe(true);
  expect(analysis.workloads[0]!.cleanRounds).toBe(4);
});
