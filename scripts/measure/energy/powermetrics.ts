/** Controls the powermetrics sampler and names its timing constants. */

import { userInfo } from "node:os";

import type { Runner } from "../quiet-session/runner.ts";

/** One sample every 500 ms, the interval the analysis expects. */
export const SAMPLE_INTERVAL_MS = 500;

/** Extra time in the sample limit, so powermetrics stops by itself if the tool dies. */
export const SAMPLE_MARGIN_SECONDS = 300;

/** Lead time between starting powermetrics and the first block. */
export const START_LEAD_SECONDS = 3;

/** How long a TERM is given before KILL. */
export const TERMINATION_GRACE_SECONDS = 10;

/** Two samples are enough to see the shape powermetrics writes. */
export const PREFLIGHT_SAMPLES = 2;

const MILLISECONDS_PER_SECOND = 1_000;

/** Samples needed to cover the planned block time plus the margin. */
export function plannedSampleLimit(plannedSeconds: number): number {
  return Math.ceil(
    ((plannedSeconds + SAMPLE_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND) / SAMPLE_INTERVAL_MS,
  );
}

export function powermetricsArguments(limit: number, outputPath: string): string[] {
  return [
    "sudo",
    "-n",
    "powermetrics",
    "--samplers",
    "cpu_power",
    "-i",
    String(SAMPLE_INTERVAL_MS),
    "-n",
    String(limit),
    "-b",
    "0",
    "-f",
    "plist",
    "-o",
    outputPath,
  ];
}

export type PowermetricsHandle = {
  readonly pid: number | undefined;
  /** Stops the sampler with TERM, then KILL, and gives the user the plist. Safe to call twice. */
  stop: () => Promise<void>;
};

export type StartPowermetricsOptions = {
  runner: Runner;
  outputPath: string;
  sampleLimit: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function startPowermetrics(options: StartPowermetricsOptions): PowermetricsHandle {
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const process = options.runner.spawn(
    powermetricsArguments(options.sampleLimit, options.outputPath),
  );
  let stopping: Promise<void> | undefined;
  return {
    pid: process.pid,
    stop() {
      stopping ??= stopPowermetrics(options.runner, process.pid, options.outputPath, sleep);
      return stopping;
    },
  };
}

async function stopPowermetrics(
  runner: Runner,
  pid: number | undefined,
  outputPath: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (pid !== undefined) {
    await runner.capture(["sudo", "-n", "kill", "-TERM", String(pid)]);
    // Never wait without a limit: a sampler that ignores TERM must not hold the run.
    for (let second = 0; second < TERMINATION_GRACE_SECONDS; second++) {
      if (!(await isRunning(runner, pid))) {
        break;
      }
      await sleep(MILLISECONDS_PER_SECOND);
    }
    if (await isRunning(runner, pid)) {
      await runner.capture(["sudo", "-n", "pkill", "-KILL", "-x", "powermetrics"]);
      await runner.capture(["sudo", "-n", "kill", "-KILL", String(pid)]);
    }
  }
  await runner.capture(["sudo", "-n", "chown", userInfo().username, outputPath]);
}

async function isRunning(runner: Runner, pid: number): Promise<boolean> {
  const result = await runner.capture(["ps", "-p", String(pid)]);
  return result.exitCode === 0;
}
