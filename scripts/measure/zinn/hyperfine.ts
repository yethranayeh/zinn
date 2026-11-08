/** hyperfine arguments and reading its 2.x JSON export. */

import { readFile } from "node:fs/promises";

import { shellQuote } from "../quiet-session/format.ts";
import type { FixedEnvironment } from "./exec.ts";
import { median, p95 } from "./stats.ts";

export type HyperfineEntry = {
  name: string;
  command: string;
};

export type HyperfineArgumentsOptions = {
  runs: number;
  warmup: number;
  prepare?: string;
  exportPath: string;
  entries: readonly HyperfineEntry[];
};

export function buildHyperfineArguments(options: HyperfineArgumentsOptions): string[] {
  const args = [
    "hyperfine",
    "-N",
    "--warmup",
    String(options.warmup),
    "--runs",
    String(options.runs),
  ];
  if (options.prepare !== undefined) {
    args.push("--prepare", options.prepare);
  }
  args.push("--export-json", options.exportPath);
  for (const entry of options.entries) {
    args.push("-n", entry.name, entry.command);
  }
  return args;
}

/** Builds the env -i command string hyperfine splits, with shell quoting for the title. */
export function buildCommandLine(options: {
  environment: FixedEnvironment;
  argv: readonly string[];
}): string {
  const parts = [
    "env",
    "-i",
    `PATH=${shellQuote(options.environment.PATH)}`,
    `HOME=${shellQuote(options.environment.HOME)}`,
    `ZINN_DIR=${shellQuote(options.environment.ZINN_DIR)}`,
    ...options.argv,
  ];
  return parts.map(shellQuote).join(" ");
}

export function buildPrepareCommand(options: {
  databasePath: string;
  backupDirectory: string;
  fixtureDatabasePath: string;
}): string {
  const targets = [
    options.databasePath,
    `${options.databasePath}-wal`,
    `${options.databasePath}-shm`,
    options.backupDirectory,
  ];
  return `rm -rf ${targets.map(shellQuote).join(" ")} && cp ${shellQuote(
    options.fixtureDatabasePath,
  )} ${shellQuote(options.databasePath)}`;
}

type HyperfineValue = {
  value: number;
  unit: string;
};

type HyperfineMeasurement = {
  time_wall_clock: HyperfineValue;
  memory_peak_resident: HyperfineValue;
};

type HyperfineDocument = {
  schema_version?: number;
  results?: Array<{
    command?: string;
    /** hyperfine 2.x stores the -n name here, separately from the command text. */
    name?: string;
    measurements?: HyperfineMeasurement[];
  }>;
};

export type CommandTiming = {
  p50WallSeconds: number;
  p95WallSeconds: number;
  medianPeakBytes: number;
};

const HYPERFINE_SCHEMA_VERSION = 2;
const WALL_UNIT = "second";
const MEMORY_UNIT = "byte";

/** Reads one export and summarizes every named command. */
export async function readHyperfineSummary(
  filePath: string,
  names: readonly string[],
): Promise<Record<string, CommandTiming>> {
  const document = JSON.parse(await readFile(filePath, "utf8")) as HyperfineDocument;
  if (document.schema_version !== HYPERFINE_SCHEMA_VERSION) {
    throw new Error(
      `Expected hyperfine JSON schema ${HYPERFINE_SCHEMA_VERSION} in ${filePath}, got ${String(
        document.schema_version,
      )}`,
    );
  }
  const summary: Record<string, CommandTiming> = {};
  for (const name of names) {
    const result = (document.results ?? []).find(
      (entry) => (entry.name ?? entry.command) === name,
    );
    if (result === undefined) {
      throw new Error(`hyperfine wrote no result for ${name} in ${filePath}`);
    }
    const measurements = result.measurements ?? [];
    if (measurements.length === 0) {
      throw new Error(`hyperfine wrote no runs for ${name} in ${filePath}`);
    }
    const wallSeconds = measurements.map((measurement) => {
      assertUnit(measurement.time_wall_clock, WALL_UNIT, name);
      return measurement.time_wall_clock.value;
    });
    const peakBytes = measurements.map((measurement) => {
      assertUnit(measurement.memory_peak_resident, MEMORY_UNIT, name);
      return measurement.memory_peak_resident.value;
    });
    summary[name] = {
      p50WallSeconds: median(wallSeconds),
      p95WallSeconds: p95(wallSeconds),
      medianPeakBytes: median(peakBytes),
    };
  }
  return summary;
}

function assertUnit(value: HyperfineValue, expected: string, name: string): void {
  if (value.unit !== expected) {
    throw new Error(`hyperfine reported ${name} in ${value.unit}, expected ${expected}`);
  }
}
