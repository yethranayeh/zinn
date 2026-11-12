/** The energy mode: workloads built from the command set and the fixture cache. */

import { readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  analyze,
  formatAnalysis,
  MINIMUM_CLEAN_ROUNDS,
  workloadsShortOfCleanRounds,
  type Analysis,
} from "../energy/analysis.ts";
import { formatBlockHeader, formatBlockRow, type BlockRow } from "../energy/blocks.ts";
import {
  checkPowermetrics,
  runPreflight,
  startSudoKeepalive,
  type PowermetricsCheck,
} from "../energy/preflight.ts";
import {
  plannedSampleLimit,
  startPowermetrics,
  START_LEAD_SECONDS,
} from "../energy/powermetrics.ts";
import { parsePowerLog } from "../energy/samples.ts";
import {
  findContaminatedBlocks,
  QUIET_LOAD,
  QUIET_WAIT_LIMIT_SECONDS,
  waitForQuiet,
  type QuietWait,
} from "../energy/gate.ts";
import { roundOrders, runBlocks, SCHEDULE_SEED, type Workload } from "../energy/schedule.ts";
import { parseSamplesFile, SESSION_SAMPLES_ENV } from "../quiet-session/sampler.ts";
import { createRecordFolder, writeJson, writeMeta } from "../record.ts";
import type { Runner } from "../quiet-session/runner.ts";
import type { EnergyArguments } from "./args.ts";
import { DEFAULT_ENERGY_SIZES } from "./args.ts";
import { COMMAND_NAMES, selectCommands } from "./commands.ts";
import { measuredEnvironment } from "./exec.ts";
import { buildMeta } from "./meta.ts";
import { removeRunDirectory, resolveScratchDirectory } from "./paths.ts";
import {
  ensureFixture,
  fixtureDatabasePath,
  fixtureSpec,
  type InstallInfo,
} from "./setup.ts";
import { readLoadAverages } from "./system.ts";

/** Arguments for the plain node run that has no fixture. */
const NODE_ARGS = ["-e", "0"] as const;

const MILLISECONDS_PER_SECOND = 1_000;

/** Samples kept after the last block, so its final interval is complete in the log. */
const TRAILING_SAMPLE_SECONDS = 2;

/** Exit codes for a run stopped by a signal, as a shell reports them. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/** Extra rounds at most, each for the workloads still short of clean rounds. */
const MAXIMUM_EXTRA_ROUNDS = 3;

/** The fixtures the default workload set uses. */
const SMALL_FIXTURE_TASKS = 100;
const LARGE_FIXTURE_TASKS = 10_000;

type PlannedWorkload = {
  /** Undefined for the plain node run. */
  command: string | undefined;
  size: number | undefined;
};

/** The default set: node, four commands at 100 tasks, and list at 10000 tasks. */
export const DEFAULT_ENERGY_WORKLOADS: readonly PlannedWorkload[] = [
  { command: undefined, size: undefined },
  { command: "list", size: SMALL_FIXTURE_TASKS },
  { command: "list-json", size: SMALL_FIXTURE_TASKS },
  { command: "view", size: SMALL_FIXTURE_TASKS },
  { command: "create", size: SMALL_FIXTURE_TASKS },
  { command: "list", size: LARGE_FIXTURE_TASKS },
];

export function energyWorkloadPlan(arguments_: EnergyArguments): PlannedWorkload[] {
  if (arguments_.commands === undefined && arguments_.sizes === undefined) {
    return DEFAULT_ENERGY_WORKLOADS.map((entry) => ({ ...entry }));
  }
  const commands = arguments_.commands ?? [...COMMAND_NAMES];
  const sizes = arguments_.sizes ?? [...DEFAULT_ENERGY_SIZES];
  const plan: PlannedWorkload[] = [{ command: undefined, size: undefined }];
  for (const command of commands) {
    for (const size of sizes) {
      plan.push({ command, size });
    }
  }
  return plan;
}

export function energyWorkloadLabel(entry: PlannedWorkload): string {
  if (entry.command === undefined) {
    return "node";
  }
  if (entry.size === undefined) {
    throw new Error(`The ${entry.command} workload needs a fixture size`);
  }
  return `${entry.command}@${entry.size}`;
}

type EnergyRunOptions = {
  parsed: EnergyArguments;
  version: string;
  arguments: readonly string[];
  runner: Runner;
  repositoryRoot: string;
  resultsDirectory: string;
  workDirectory: string;
  install: InstallInfo;
  nodePath: string;
  nodeVersion: string;
};

export async function runEnergy(options: EnergyRunOptions): Promise<void> {
  const fixturesDirectory = path.join(options.workDirectory, "fixtures");
  const runsDirectory = path.join(options.workDirectory, "runs");
  await mkdir(fixturesDirectory, { recursive: true });
  await mkdir(runsDirectory, { recursive: true });

  const plan = energyWorkloadPlan(options.parsed);
  const sizes = [...new Set(plan.flatMap((entry) => (entry.size === undefined ? [] : [entry.size])))];
  for (const tasks of sizes) {
    const spec = fixtureSpec(tasks, true);
    await ensureFixture({
      spec,
      fixturesDirectory,
      workDirectory: options.workDirectory,
      coreIndex: options.install.coreIndex,
      nodePath: options.nodePath,
    });
  }

  const machine = await runPreflight({
    runner: options.runner,
    freeDiskPath: options.repositoryRoot,
    write: (line) => console.log(line),
  });

  const preflightDirectory = await mkdtemp(path.join(tmpdir(), "zinn-energy-preflight-"));
  let sampler: PowermetricsCheck;
  try {
    sampler = await checkPowermetrics({
      runner: options.runner,
      outputPath: path.join(preflightDirectory, "powermetrics.plist"),
      write: (line) => console.log(line),
    });
  } finally {
    await rm(preflightDirectory, { recursive: true, force: true });
  }

  const startedAt = new Date();
  const loadStart = await readLoadAverages(options.runner);
  const recordDirectory = await createRecordFolder(
    options.resultsDirectory,
    `energy-${options.version}`,
    startedAt,
  );
  const blocksPath = path.join(recordDirectory, "blocks.tsv");
  const powerPath = path.join(recordDirectory, "power.plist");
  await writeFile(blocksPath, `${formatBlockHeader()}\n`);

  const workloads = createWorkloads({
    plan,
    fixturesDirectory,
    runsDirectory,
    workDirectory: options.workDirectory,
    install: options.install,
    nodePath: options.nodePath,
  });
  const blockSeconds =
    options.parsed.settleSeconds + options.parsed.idleSeconds + options.parsed.workSeconds;
  const plannedSeconds = plan.length * options.parsed.rounds * blockSeconds;
  const mostBlocks = plan.length * (options.parsed.rounds + MAXIMUM_EXTRA_ROUNDS);
  const longestSeconds =
    plannedSeconds +
    plan.length * MAXIMUM_EXTRA_ROUNDS * blockSeconds +
    mostBlocks * QUIET_WAIT_LIMIT_SECONDS;
  const sampleLimit = plannedSampleLimit(longestSeconds);
  console.log(
    `Plan:   ${plannedSeconds}s of blocks, at most ${longestSeconds}s with extra rounds and quiet waits`,
  );
  console.log(`        powermetrics stops by itself after ${sampleLimit} samples`);
  const sessionSamplesPath = process.env[SESSION_SAMPLES_ENV];
  console.log(
    sessionSamplesPath === undefined
      ? "Gate:   no session samples, so blocks are not checked for background work"
      : `Gate:   checking blocks against ${sessionSamplesPath}`,
  );
  const quietWaits: QuietWait[] = [];
  const analyzeSoFar = (blockRows: readonly BlockRow[]): Analysis => {
    const samples = parsePowerLog(readFileSync(powerPath, "utf8"));
    if (sessionSamplesPath === undefined) {
      return analyze(samples, blockRows);
    }
    const sessionSamples = parseSamplesFile(readFileSync(sessionSamplesPath, "utf8"));
    const contaminated = findContaminatedBlocks(sessionSamples, blockRows);
    return analyze(samples, blockRows, contaminated);
  };

  const stopKeepalive = startSudoKeepalive(options.runner);
  // Keeps the Mac awake for as long as this process runs.
  const awake = options.runner.spawn(["caffeinate", "-is", "-w", String(process.pid)]);
  const power = startPowermetrics({
    runner: options.runner,
    outputPath: powerPath,
    sampleLimit,
  });
  // A stop by signal skips the finally below, so the sampler is stopped here too.
  const signalHandlers = Object.entries(SIGNAL_EXIT_CODES).map(([signal, exitCode]) => {
    const handler = () => {
      console.error(`Stopped by ${signal}. Stopping powermetrics.`);
      void power.stop().finally(() => process.exit(exitCode));
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const blockOptions = {
    workloads,
    rounds: options.parsed.rounds,
    idleSeconds: options.parsed.idleSeconds,
    workSeconds: options.parsed.workSeconds,
    settleSeconds: options.parsed.settleSeconds,
    runner: options.runner,
    beforeBlock: async (round: number, label: string) => {
      const wait = await waitForQuiet({
        round,
        label,
        readLoad: async () => (await readLoadAverages(options.runner))[0]!,
        sleep,
      });
      if (wait !== undefined) {
        quietWaits.push(wait);
        const outcome = wait.timedOut ? "still busy, running anyway" : `now ${wait.loadAfter}`;
        console.log(
          `  waited ${wait.waitedSeconds}s for load ${wait.loadBefore} to fall below ${QUIET_LOAD}: ${outcome}`,
        );
      }
    },
    onBlock: async (row: BlockRow) => {
      await appendFile(blocksPath, `${formatBlockRow(row)}\n`);
    },
    onProgress: (done: number, total: number, row: BlockRow) => {
      console.log(`  block ${done}/${total}: ${row.label}, ${row.count} runs`);
    },
  };
  let rows: BlockRow[] = [];
  let extraRounds = 0;
  try {
    await sleep(START_LEAD_SECONDS * MILLISECONDS_PER_SECOND);
    rows = await runBlocks(blockOptions);
    await sleep(TRAILING_SAMPLE_SECONDS * MILLISECONDS_PER_SECOND);
    // A run planned below the minimum, such as --check, is not topped up.
    const topsUp = options.parsed.rounds >= MINIMUM_CLEAN_ROUNDS;
    while (topsUp && extraRounds < MAXIMUM_EXTRA_ROUNDS) {
      const short = workloadsShortOfCleanRounds(analyzeSoFar(rows));
      if (short.length === 0) {
        break;
      }
      const round = options.parsed.rounds + extraRounds + 1;
      console.log(
        `Extra round ${round}: fewer than ${MINIMUM_CLEAN_ROUNDS} clean rounds for ${short.join(", ")}`,
      );
      rows.push(
        ...(await runBlocks({
          ...blockOptions,
          orders: roundOrders(short, 1, SCHEDULE_SEED + round),
          firstRound: round,
        })),
      );
      extraRounds++;
      await sleep(TRAILING_SAMPLE_SECONDS * MILLISECONDS_PER_SECOND);
    }
  } finally {
    await power.stop();
    stopKeepalive();
    await awake.stop();
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }

  const endedAt = new Date();
  const loadEnd = await readLoadAverages(options.runner);
  await writeMeta(
    recordDirectory,
    await buildMeta({
      mode: "energy",
      version: options.version,
      arguments: options.arguments,
      runner: options.runner,
      repositoryRoot: options.repositoryRoot,
      install: options.install,
      nodePath: options.nodePath,
      nodeVersion: options.nodeVersion,
      loadStart,
      loadEnd,
      startedAt,
      endedAt,
      extra: {
        preflight: machine,
        build: sampler.build,
        buildVerified: sampler.buildVerified,
        powermetricsPreflight: sampler,
        quietGate: {
          load: QUIET_LOAD,
          waitLimitSeconds: QUIET_WAIT_LIMIT_SECONDS,
          sessionSamples: sessionSamplesPath ?? null,
          waits: quietWaits,
          extraRounds,
        },
      },
    }),
  );

  const analysis = analyzeSoFar(rows);
  await writeJson(recordDirectory, "analysis.json", analysis);
  console.log("");
  console.log(formatAnalysis(analysis).join("\n"));
  console.log("");
  console.log(`Results: ${recordDirectory}`);
}

function createWorkloads(options: {
  plan: readonly PlannedWorkload[];
  fixturesDirectory: string;
  runsDirectory: string;
  workDirectory: string;
  install: InstallInfo;
  nodePath: string;
}): Workload[] {
  const scratch = resolveScratchDirectory(options.runsDirectory, path.join("energy", "dir"));
  return options.plan.map((entry) => {
    const label = energyWorkloadLabel(entry);
    const command = entry.command === undefined ? undefined : selectCommands([entry.command])[0];
    if (entry.command !== undefined && command === undefined) {
      throw new Error(`Unknown command in the energy plan: ${entry.command}`);
    }
    const fixture =
      entry.size === undefined ? undefined : fixtureSpec(entry.size, true);
    return {
      label,
      async prepare() {
        await removeRunDirectory(scratch, options.runsDirectory);
        await mkdir(path.join(scratch, "data"), { recursive: true });
        if (fixture !== undefined) {
          await copyFile(
            fixtureDatabasePath(options.fixturesDirectory, fixture.name),
            path.join(scratch, "data", "zinn.sqlite"),
          );
        }
        const argv =
          command === undefined
            ? [options.nodePath, ...NODE_ARGS]
            : [options.nodePath, options.install.cliIndex, ...command.args];
        return {
          argv,
          env: measuredEnvironment(scratch),
          cwd: options.workDirectory,
        };
      },
    };
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
