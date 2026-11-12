import { expect, test } from "bun:test";

import type { SessionSample } from "../quiet-session/sampler.ts";
import type { BlockRow } from "./blocks.ts";
import {
  findContaminatedBlocks,
  NOISY_PROCESS_CPU_PERCENT,
  QUIET_LOAD,
  QUIET_WAIT_LIMIT_SECONDS,
  waitForQuiet,
} from "./gate.ts";

function loads(...values: number[]) {
  let index = 0;
  let sleptMs = 0;
  return {
    readLoad: async () => values[Math.min(index++, values.length - 1)]!,
    sleep: async (milliseconds: number) => {
      sleptMs += milliseconds;
    },
    slept: () => sleptMs,
  };
}

test("a quiet machine starts the block without waiting", async () => {
  const fake = loads(QUIET_LOAD - 1);
  expect(await waitForQuiet({ round: 1, label: "node", ...fake })).toBeUndefined();
  expect(fake.slept()).toBe(0);
});

test("a busy machine waits until the load falls", async () => {
  const fake = loads(QUIET_LOAD + 2, QUIET_LOAD + 1, QUIET_LOAD - 1);
  const wait = await waitForQuiet({ round: 2, label: "node", ...fake });
  expect(wait).toMatchObject({ round: 2, label: "node", timedOut: false, loadAfter: QUIET_LOAD - 1 });
  expect(wait!.waitedSeconds).toBeGreaterThan(0);
  expect(fake.slept()).toBe(wait!.waitedSeconds * 1000);
});

test("the wait stops at its limit and the block runs anyway", async () => {
  const fake = loads(QUIET_LOAD + 2);
  const wait = await waitForQuiet({ round: 1, label: "node", ...fake });
  expect(wait).toMatchObject({ timedOut: true, waitedSeconds: QUIET_WAIT_LIMIT_SECONDS });
});

function block(round: number, kind: "idle" | "work", start: number, end: number): BlockRow {
  return { round, label: "node", kind, start, end, count: kind === "work" ? 10 : 0 };
}

function sessionSample(
  seconds: number,
  load1: number,
  processes: SessionSample["processes"] = [],
): SessionSample {
  return { seconds, load1, processes };
}

test("blocks with high load or a busy noisy process are contaminated", () => {
  const blocks = [block(1, "idle", 0, 20), block(1, "work", 20, 40), block(2, "idle", 40, 60)];
  const samples = [
    sessionSample(5, 1.5, [{ cpuPercent: 90, command: "/usr/libexec/PerfPowerServices" }]),
    sessionSample(25, 1.5, [
      { cpuPercent: NOISY_PROCESS_CPU_PERCENT, command: "/System/Library/Frameworks/CoreServices.framework/mds_stores" },
    ]),
    sessionSample(45, QUIET_LOAD + 0.5),
    sessionSample(70, QUIET_LOAD + 5),
  ];
  expect(findContaminatedBlocks(samples, blocks)).toEqual([
    {
      round: 1,
      label: "node",
      kind: "work",
      reason: "process",
      observed: NOISY_PROCESS_CPU_PERCENT,
      limit: NOISY_PROCESS_CPU_PERCENT,
      process: "mds_stores",
    },
    { round: 2, label: "node", kind: "idle", reason: "load", observed: QUIET_LOAD + 0.5, limit: QUIET_LOAD },
  ]);
});
