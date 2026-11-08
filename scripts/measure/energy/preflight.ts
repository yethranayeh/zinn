/** Checks the machine and the sampler before a real energy run. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Runner } from "../quiet-session/runner.ts";
import { isPlistDict, parsePlist, plistPath, type PlistDict, type PlistValue } from "./plist.ts";
import {
  PREFLIGHT_SAMPLES,
  powermetricsArguments,
  SAMPLE_INTERVAL_MS,
} from "./powermetrics.ts";
import { parsePowerLog } from "./samples.ts";

/** Below this many free bytes the run stops. */
export const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** A one-minute load above this warns that other work will widen the spread. */
export const MAXIMUM_LOAD_AVERAGE = 3;

/** The sudo ticket is refreshed at this interval while the run is active. */
export const SUDO_REFRESH_MS = 50_000;

/** Number of busiest processes printed before a run. */
export const BUSIEST_PROCESS_COUNT = 5;

/** Width of one busiest-process line. */
export const PROCESS_LINE_WIDTH = 70;

/** Highest plausible combined power in milliwatts. */
export const MAXIMUM_POWER_MW = 200_000;

/** Lowest plausible combined power in milliwatts. */
export const MINIMUM_POWER_MW = 0;

/** Allowed relative difference between elapsed_ns and the sampling interval. */
export const ELAPSED_TOLERANCE = 0.2;

const BYTES_PER_KILOBYTE = 1_024;
const KILOBYTES_PER_MEGABYTE = 1_024;
const NANOSECONDS_PER_SECOND = 1e9;
const MILLISECONDS_PER_SECOND = 1_000;
const LOAD_WARNING_DECIMALS = 2;

/** The key paths a usable powermetrics sample must carry. */
export const REQUIRED_SAMPLE_PATHS = [
  "elapsed_ns",
  "timestamp",
  "kern_osversion",
  "hw_model",
  "processor.combined_power",
] as const;

export type SampleIssue = {
  path: string;
  problem: string;
};

export type PreflightReport = {
  powerSource: string;
  loadAverage: number;
  freeBytes: number;
};

export type PreflightOptions = {
  runner: Runner;
  freeDiskPath: string;
  write: (line: string) => void;
  stdinIsTerminal?: boolean;
  minimumFreeBytes?: number;
  maximumLoadAverage?: number;
};

export type PowermetricsCheck = {
  sampleCount: number;
  build: string;
  buildVerified: boolean;
  knownGoodPath: string | undefined;
  issues: SampleIssue[];
};

export type PowermetricsCheckOptions = {
  runner: Runner;
  outputPath: string;
  write: (line: string) => void;
  knownGoodDirectory?: string;
};

/** Prints the machine state, stops on low disk and makes sure sudo has a ticket. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const minimumFreeBytes = options.minimumFreeBytes ?? MINIMUM_FREE_BYTES;
  const maximumLoadAverage = options.maximumLoadAverage ?? MAXIMUM_LOAD_AVERAGE;

  const battery = await capture(options.runner, ["pmset", "-g", "batt"]);
  const powerSource = battery.split(/\r?\n/)[0]?.trim() ?? "";
  const loadValues = await readLoadValues(options.runner);
  const loadAverage = loadValues[0] ?? 0;
  const freeBytes = await readFreeBytes(options.runner, options.freeDiskPath);
  const busiest = await readBusiestProcesses(options.runner);

  options.write(`Power:  ${powerSource}`);
  options.write(
    `Load:   ${loadValues.map((value) => value.toFixed(LOAD_WARNING_DECIMALS)).join(" ")}`,
  );
  options.write(`Disk:   ${Math.floor(freeBytes / BYTES_PER_KILOBYTE / KILOBYTES_PER_MEGABYTE)} MB free`);
  options.write("Top CPU right now:");
  for (const line of busiest) {
    options.write(`  ${line}`);
  }
  if (freeBytes < minimumFreeBytes) {
    throw new Error("STOP: less than 2 GB free. Free some disk first.");
  }
  if (!powerSource.includes("AC Power")) {
    options.write("WARNING: not on AC power.");
  }
  if (loadAverage > maximumLoadAverage) {
    options.write(
      `WARNING: load is ${loadAverage.toFixed(LOAD_WARNING_DECIMALS)}. Agents or builds still running will widen the spread.`,
    );
  }

  await ensureSudoTicket(options.runner, options.stdinIsTerminal ?? process.stdin.isTTY === true);
  return { powerSource, loadAverage, freeBytes };
}

/** Refreshes the sudo ticket in the background. Returns a function that stops the refresh. */
export function startSudoKeepalive(
  runner: Runner,
  intervalMs: number = SUDO_REFRESH_MS,
): () => void {
  const timer = setInterval(() => {
    void runner.capture(["sudo", "-n", "true"]);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function ensureSudoTicket(runner: Runner, stdinIsTerminal: boolean): Promise<void> {
  const result = await runner.capture(["sudo", "-n", "true"]);
  if (result.exitCode === 0) {
    return;
  }
  if (!stdinIsTerminal) {
    throw new Error(
      "sudo needs a password. Run under `bun run measure:quiet` or run `sudo -v` first.",
    );
  }
  const interactive = await runner.interactive(["sudo", "-v"]);
  if (interactive.exitCode !== 0) {
    throw new Error("sudo -v failed. Run `sudo -v` first, then start the run again.");
  }
}

/** Takes two samples and checks their shape against the newest known-good sample. */
export async function checkPowermetrics(
  options: PowermetricsCheckOptions,
): Promise<PowermetricsCheck> {
  const run = await options.runner.capture(
    powermetricsArguments(PREFLIGHT_SAMPLES, options.outputPath),
  );
  if (run.exitCode !== 0) {
    throw new Error(`powermetrics preflight failed with exit code ${run.exitCode}:\n${run.stderr.trim()}`);
  }
  if (!existsSync(options.outputPath)) {
    throw new Error(`powermetrics wrote no ${options.outputPath}`);
  }
  const samples = parsePowerLog(readFileSync(options.outputPath, "utf8"));
  if (samples.length === 0) {
    throw new Error("powermetrics wrote no usable samples");
  }
  const directory = options.knownGoodDirectory ?? knownGoodDirectory();
  const issues: SampleIssue[] = [];
  for (const sample of samples) {
    issues.push(...inspectSample(sample.record));
  }
  if (issues.length > 0) {
    const newest = newestKnownGood(directory);
    options.write(`powermetrics sample mismatch (${samples.length} samples)`);
    for (const line of describeDifferences(samples[0]!.record, newest?.record)) {
      options.write(`  ${line}`);
    }
    throw new Error("powermetrics returned an unexpected shape. The key paths above differ.");
  }

  const build = samples[0]!.record.kern_osversion as string;
  const path = knownGoodPath(directory, build);
  const knownGood = existsSync(path) ? parsePlist(readFileSync(path, "utf8")) : undefined;
  const buildVerified = knownGood !== undefined;
  if (buildVerified) {
    options.write(`powermetrics build ${build} matches the known-good sample`);
  } else {
    options.write(
      `powermetrics build ${build} is untested. After a verified run, add a known-good sample at ${path}`,
    );
  }
  return {
    sampleCount: samples.length,
    build,
    buildVerified,
    knownGoodPath: buildVerified ? path : undefined,
    issues,
  };
}

/** Returns the key paths that are missing, the wrong type, or implausible in one sample. */
export function inspectSample(
  record: PlistDict,
  intervalMs: number = SAMPLE_INTERVAL_MS,
): SampleIssue[] {
  const issues: SampleIssue[] = [];
  const elapsed = record.elapsed_ns;
  const expectedSeconds = intervalMs / MILLISECONDS_PER_SECOND;
  if (typeof elapsed !== "number") {
    issues.push({ path: "elapsed_ns", problem: "missing or not an integer" });
  } else {
    const seconds = elapsed / NANOSECONDS_PER_SECOND;
    const tolerance = expectedSeconds * ELAPSED_TOLERANCE;
    if (Math.abs(seconds - expectedSeconds) > tolerance) {
      issues.push({
        path: "elapsed_ns",
        problem: `${seconds.toFixed(3)} s is not within 20% of ${expectedSeconds.toFixed(3)} s`,
      });
    }
  }
  const timestamp = record.timestamp;
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    issues.push({ path: "timestamp", problem: "missing or not a date" });
  }
  if (typeof record.kern_osversion !== "string" || record.kern_osversion.length === 0) {
    issues.push({ path: "kern_osversion", problem: "missing or not a string" });
  }
  if (typeof record.hw_model !== "string" || record.hw_model.length === 0) {
    issues.push({ path: "hw_model", problem: "missing or not a string" });
  }
  const power = plistPath(record, "processor.combined_power");
  if (typeof power !== "number") {
    issues.push({ path: "processor.combined_power", problem: "missing or not a number" });
  } else if (power < MINIMUM_POWER_MW || power > MAXIMUM_POWER_MW) {
    issues.push({
      path: "processor.combined_power",
      problem: `${power.toFixed(0)} mW is outside ${MINIMUM_POWER_MW} to ${MAXIMUM_POWER_MW} mW`,
    });
  }
  return issues;
}

/** Key paths whose presence or type differs from the known-good sample. */
export function describeDifferences(
  record: PlistDict,
  knownGood: PlistDict | undefined,
): string[] {
  const problems = new Map(inspectSample(record).map((issue) => [issue.path, issue.problem]));
  const lines: string[] = [];
  for (const keyPath of REQUIRED_SAMPLE_PATHS) {
    const current = plistPath(record, keyPath);
    const expected = knownGood === undefined ? undefined : plistPath(knownGood, keyPath);
    const problem = problems.get(keyPath);
    if (problem === undefined && current !== undefined && sameShape(current, expected)) {
      continue;
    }
    const currentText = problem ?? describeValue(current);
    const expectedText =
      knownGood === undefined ? "no known-good sample" : describeValue(expected);
    lines.push(`${keyPath}: ${currentText} (known-good ${expectedText})`);
  }
  return lines;
}

export function knownGoodDirectory(): string {
  return path.join(import.meta.dir, "known-good");
}

export function knownGoodPath(directory: string, build: string): string {
  return path.join(directory, `${build}.plist`);
}

/** The known-good sample for this build, or undefined when the build has none. */
export function loadKnownGood(
  build: string,
  directory: string = knownGoodDirectory(),
): PlistDict | undefined {
  const file = knownGoodPath(directory, build);
  if (!existsSync(file)) {
    return undefined;
  }
  return parsePlist(readFileSync(file, "utf8"));
}

/** The known-good sample with the newest build name, used to explain a mismatch. */
export function newestKnownGood(
  directory: string = knownGoodDirectory(),
): { name: string; record: PlistDict } | undefined {
  if (!existsSync(directory)) {
    return undefined;
  }
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".plist"))
    .sort()
    .reverse();
  const name = names[0];
  if (name === undefined) {
    return undefined;
  }
  return { name, record: parsePlist(readFileSync(path.join(directory, name), "utf8")) };
}

async function capture(runner: Runner, argv: readonly string[]): Promise<string> {
  const result = await runner.capture(argv);
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${result.exitCode}:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function readLoadValues(runner: Runner): Promise<number[]> {
  const output = await capture(runner, ["sysctl", "-n", "vm.loadavg"]);
  const values = output.match(/[0-9]+(?:\.[0-9]+)?/g);
  if (values === null || values.length < 3) {
    throw new Error(`Could not parse load averages from: ${output}`);
  }
  return values.slice(0, 3).map(Number);
}

async function readFreeBytes(runner: Runner, target: string): Promise<number> {
  const output = await capture(runner, ["df", "-k", target]);
  const line = output.split(/\r?\n/)[1];
  if (line === undefined) {
    throw new Error(`df printed no data for ${target}`);
  }
  const fields = line.trim().split(/\s+/);
  const freeKilobytes = Number(fields[3]);
  if (!Number.isFinite(freeKilobytes)) {
    throw new Error(`Could not read free space from: ${line}`);
  }
  return freeKilobytes * BYTES_PER_KILOBYTE;
}

async function readBusiestProcesses(runner: Runner): Promise<string[]> {
  const output = await capture(runner, ["ps", "-Ao", "%cpu,comm", "-r"]);
  return output
    .split(/\r?\n/)
    .slice(1, 1 + BUSIEST_PROCESS_COUNT)
    .map((line) => line.trim().slice(0, PROCESS_LINE_WIDTH))
    .filter((line) => line.length > 0);
}

function sameShape(left: PlistValue | undefined, right: PlistValue | undefined): boolean {
  return valueKind(left) === valueKind(right);
}

function valueKind(value: PlistValue | undefined): string {
  if (value === undefined) {
    return "missing";
  }
  if (value instanceof Date) {
    return "date";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlistDict(value)) {
    return "dictionary";
  }
  return typeof value;
}

function describeValue(value: PlistValue | undefined): string {
  if (value === undefined) {
    return "missing";
  }
  if (value instanceof Date) {
    return `date ${value.toISOString()}`;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlistDict(value)) {
    return "dictionary";
  }
  return `${typeof value} ${String(value)}`;
}
