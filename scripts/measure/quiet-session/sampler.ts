/** Samples the load averages and the busiest processes while a session runs. */

import type { Runner } from "./runner.ts";

import { appendFileSync, writeFileSync } from "node:fs";

export const SAMPLES_FILE_NAME = "samples.tsv";
export const DEFAULT_SAMPLE_SECONDS = 5;
/** Tells each job where the running session writes its samples. */
export const SESSION_SAMPLES_ENV = "ZINN_MEASURE_SESSION_SAMPLES";

/** Processes kept per sample, busiest first. */
const PROCESSES_PER_SAMPLE = 10;
const LOAD_COMMAND = ["sysctl", "-n", "vm.loadavg"];
/** ps CPU on macOS is a decaying average, so it shows who has been busy rather than an instant reading. */
const PROCESS_COMMAND = ["ps", "-A", "-r", "-o", "pcpu=,rss=,pid=,comm="];
const MILLISECONDS_PER_SECOND = 1_000;
const HEADER = ["time", "load1", "load5", "load15", "cpu_percent", "rss_kb", "pid", "command"];

export type Sampler = {
  stop: () => Promise<void>;
};

export type SamplerOptions = {
  runner: Runner;
  path: string;
  intervalMs: number;
  now: () => Date;
  /** Called once, for the first failed sample. */
  onFirstFailure: (message: string) => void;
};

export function startSampler(options: SamplerOptions): Sampler {
  writeFileSync(options.path, `${HEADER.join("\t")}\n`);
  let reportedFailure = false;
  let running: Promise<void> | undefined;

  const sampleOnce = async (): Promise<void> => {
    try {
      const time = options.now().toISOString();
      const [load, processes] = await Promise.all([
        options.runner.capture(LOAD_COMMAND),
        options.runner.capture(PROCESS_COMMAND),
      ]);
      if (load.exitCode !== 0 || processes.exitCode !== 0) {
        throw new Error(`sysctl exit ${load.exitCode}, ps exit ${processes.exitCode}`);
      }
      const loads = parseLoadAverages(load.stdout);
      const rows = parseProcesses(processes.stdout)
        .slice(0, PROCESSES_PER_SAMPLE)
        .map((row) => [time, ...loads, row.cpu, row.rssKb, row.pid, row.command].join("\t"));
      if (rows.length > 0) {
        appendFileSync(options.path, `${rows.join("\n")}\n`);
      }
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true;
        options.onFirstFailure(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const tick = () => {
    // Skip a tick while the previous sample is still running.
    if (running !== undefined) {
      return;
    }
    running = sampleOnce().finally(() => {
      running = undefined;
    });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

/** Parses `sysctl -n vm.loadavg` output such as "{ 1.20 1.05 0.98 }". */
export function parseLoadAverages(output: string): [string, string, string] {
  const numbers = output.match(/\d+(?:\.\d+)?/g) ?? [];
  return [numbers[0] ?? "", numbers[1] ?? "", numbers[2] ?? ""];
}

type ProcessRow = { cpu: string; rssKb: string; pid: string; command: string };

export function parseProcesses(output: string): Array<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    rows.push({ cpu: match[1]!, rssKb: match[2]!, pid: match[3]!, command: match[4]! });
  }
  return rows;
}

export type SessionSample = {
  /** Unix seconds when the sample was taken. */
  seconds: number;
  load1: number;
  processes: Array<{ cpuPercent: number; command: string }>;
};

/** Reads a samples file back into one entry per sample time, in file order. */
export function parseSamplesFile(text: string): Array<SessionSample> {
  const samples: Array<SessionSample> = [];
  let current: SessionSample | undefined;
  for (const line of text.split("\n").slice(1)) {
    const fields = line.split("\t");
    if (fields.length !== HEADER.length) {
      continue;
    }
    const [time, load1, , , cpuPercent, , , command] = fields;
    const seconds = Date.parse(time!) / MILLISECONDS_PER_SECOND;
    if (Number.isNaN(seconds)) {
      continue;
    }
    if (current === undefined || current.seconds !== seconds) {
      current = { seconds, load1: Number(load1), processes: [] };
      samples.push(current);
    }
    current.processes.push({ cpuPercent: Number(cpuPercent), command: command! });
  }
  return samples;
}
