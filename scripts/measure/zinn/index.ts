#!/usr/bin/env bun
/** Measures a published @zinn-dev/cli release against cached fixtures. */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createRecordFolder, writeJson, writeMeta } from "../record.ts";
import { createRunner, type Runner } from "../quiet-session/runner.ts";
import { parseArguments, USAGE, type TimeArguments } from "./args.ts";
import { selectCommands, STARTUP_COMMANDS } from "./commands.ts";
import { computeDiskSlopes, DISK_FIXTURES } from "./disk.ts";
import { measuredEnvironment, runWithEnvironment } from "./exec.ts";
import {
  buildCommandLine,
  buildHyperfineArguments,
  buildPrepareCommand,
  readHyperfineSummary,
  type CommandTiming,
  type HyperfineEntry,
} from "./hyperfine.ts";
import { canonicalPath, isInside, removeRunDirectory, resolveScratchDirectory } from "./paths.ts";
import {
  ensureFixture,
  ensureInstall,
  fixtureDatabasePath,
  fixtureSpec,
  type InstallInfo,
} from "./setup.ts";
import { formatTimingTable } from "./report.ts";
import {
  readHyperfineVersion,
  readLoadAverages,
  readNodeVersion,
  readRepositoryState,
  readSystemInfo,
} from "./system.ts";

type FileEntry = {
  path: string;
  bytes: number;
};

type SingleRunOutput = {
  command: string;
  stdoutBytes: number;
  exitCode: number;
  databaseBytes: number;
  files: FileEntry[];
};

type SizeRecord = {
  tasks: number;
  fixture: string;
  fixtureBytes: number;
  commands: SingleRunOutput[];
};

type MetaOptions = {
  mode: string;
  version: string;
  arguments: readonly string[];
  runner: Runner;
  repositoryRoot: string;
  install: InstallInfo;
  nodePath: string;
  nodeVersion: string;
  loadStart: number[];
  loadEnd: number[];
  startedAt: Date;
  endedAt: Date;
};

const USAGE_ERROR_EXIT = 2;

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return USAGE_ERROR_EXIT;
  }

  const runner = createRunner();
  const nodePath = Bun.which("node");
  if (nodePath === null) {
    throw new Error("No node on PATH");
  }
  const repositoryRoot = realpathSync(path.resolve(import.meta.dir, "../../.."));
  const resultsDirectory = path.join(repositoryRoot, ".measure", "results");
  const measureRoot = canonicalPath(
    process.env.ZINN_MEASURE_HOME ?? path.join(homedir(), "Library", "Caches", "zinn-measure"),
  );
  const workDirectory = canonicalPath(path.join(measureRoot, parsed.version));
  if (workDirectory === measureRoot || !isInside(workDirectory, measureRoot)) {
    throw new Error(`Refusing to use a work directory outside ${measureRoot}: ${workDirectory}`);
  }
  if (isInside(workDirectory, repositoryRoot)) {
    throw new Error(`Refusing to use a work directory inside the repository: ${workDirectory}`);
  }

  const install = await ensureInstall({ version: parsed.version, workDirectory, runner });
  const nodeVersion = await readNodeVersion(runner, nodePath);
  const common = {
    version: parsed.version,
    arguments: process.argv.slice(2),
    runner,
    repositoryRoot,
    resultsDirectory,
    workDirectory,
    install,
    nodePath,
    nodeVersion,
  };
  if (parsed.kind === "time") {
    await runTime({ ...common, parsed });
  } else {
    await runDisk(common);
  }
  return 0;
}

async function runTime(options: {
  parsed: TimeArguments;
  version: string;
  arguments: readonly string[];
  runner: Runner;
  repositoryRoot: string;
  resultsDirectory: string;
  workDirectory: string;
  install: InstallInfo;
  nodePath: string;
  nodeVersion: string;
}): Promise<void> {
  const fixturesDirectory = path.join(options.workDirectory, "fixtures");
  const runsDirectory = path.join(options.workDirectory, "runs");
  await mkdir(fixturesDirectory, { recursive: true });
  await mkdir(runsDirectory, { recursive: true });

  const selected = selectCommands(options.parsed.commands);
  for (const tasks of options.parsed.sizes) {
    const spec = fixtureSpec(tasks, true);
    await ensureFixture({
      spec,
      fixturesDirectory,
      workDirectory: options.workDirectory,
      coreIndex: options.install.coreIndex,
      nodePath: options.nodePath,
    });
  }

  const startedAt = new Date();
  const loadStart = await readLoadAverages(options.runner);
  const recordDirectory = await createRecordFolder(
    options.resultsDirectory,
    `time-${options.version}`,
    startedAt,
  );

  const sizeRecords: SizeRecord[] = [];
  const timingsBySize = new Map<number, Record<string, CommandTiming>>();

  for (const tasks of options.parsed.sizes) {
    const spec = fixtureSpec(tasks, true);
    const fixturePath = fixtureDatabasePath(fixturesDirectory, spec.name);
    const fixtureBytes = statSync(fixturePath).size;
    const scratch = resolveScratchDirectory(runsDirectory, `t${tasks}`);
    const commands: SingleRunOutput[] = [];

    for (const command of selected) {
      await prepareScratchDatabase(scratch, runsDirectory, fixturePath);
      const result = await runWithEnvironment(
        [options.nodePath, options.install.cliIndex, ...command.args],
        {
          cwd: options.workDirectory,
          environment: measuredEnvironment(scratch),
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `${command.name} at ${tasks} tasks failed with exit code ${result.exitCode}:\n${result.stderr.trim()}`,
        );
      }
      const databasePath = path.join(scratch, "data", "zinn.sqlite");
      commands.push({
        command: command.name,
        stdoutBytes: result.stdout.byteLength,
        exitCode: result.exitCode,
        databaseBytes: statSync(databasePath).size,
        files: listFiles(scratch),
      });
    }

    console.log(`Timing ${tasks} tasks`);
    const exportPath = path.join(recordDirectory, `t${tasks}.json`);
    const entries: HyperfineEntry[] = selected.map((command) => ({
      name: command.name,
      command: buildCommandLine({
        environment: measuredEnvironment(scratch),
        argv: [options.nodePath, options.install.cliIndex, ...command.args],
      }),
    }));
    const prepare = buildPrepareCommand({
      databasePath: path.join(scratch, "data", "zinn.sqlite"),
      backupDirectory: path.join(scratch, "backups"),
      fixtureDatabasePath: fixturePath,
    });
    await runHyperfine(
      options.runner,
      buildHyperfineArguments({
        runs: options.parsed.runs,
        warmup: options.parsed.warmup,
        prepare,
        exportPath,
        entries,
      }),
      options.workDirectory,
    );
    timingsBySize.set(
      tasks,
      await readHyperfineSummary(
        exportPath,
        selected.map((command) => command.name),
      ),
    );
    sizeRecords.push({ tasks, fixture: spec.name, fixtureBytes, commands });
  }

  const startupScratch = resolveScratchDirectory(runsDirectory, "startup");
  await removeRunDirectory(startupScratch, runsDirectory);
  await mkdir(startupScratch, { recursive: true });
  console.log("Timing startup");
  const startupEntries: HyperfineEntry[] = STARTUP_COMMANDS.map((command) => ({
    name: command.name,
    command: buildCommandLine({
      environment: measuredEnvironment(startupScratch),
      argv: command.nodeOnly
        ? [options.nodePath, ...command.args]
        : [options.nodePath, options.install.cliIndex, ...command.args],
    }),
  }));
  const startupExportPath = path.join(recordDirectory, "startup.json");
  await runHyperfine(
    options.runner,
    buildHyperfineArguments({
      runs: options.parsed.runs,
      warmup: options.parsed.warmup,
      exportPath: startupExportPath,
      entries: startupEntries,
    }),
    options.workDirectory,
  );
  await readHyperfineSummary(
    startupExportPath,
    STARTUP_COMMANDS.map((command) => command.name),
  );

  await writeJson(recordDirectory, "outputs.json", {
    version: options.version,
    sizes: sizeRecords,
  });

  const endedAt = new Date();
  const loadEnd = await readLoadAverages(options.runner);
  await writeMeta(
    recordDirectory,
    await buildMeta({
      mode: "time",
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
    }),
  );

  for (const record of sizeRecords) {
    const timings = timingsBySize.get(record.tasks);
    if (timings === undefined) {
      throw new Error(`No timings for ${record.tasks} tasks`);
    }
    const outputByName = new Map(record.commands.map((entry) => [entry.command, entry]));
    const rows = selected.map((command) => {
      const timing = timings[command.name];
      const output = outputByName.get(command.name);
      if (timing === undefined || output === undefined) {
        throw new Error(`No measurement for ${command.name} at ${record.tasks} tasks`);
      }
      return {
        command: command.name,
        p50WallSeconds: timing.p50WallSeconds,
        p95WallSeconds: timing.p95WallSeconds,
        medianPeakBytes: timing.medianPeakBytes,
        stdoutBytes: output.stdoutBytes,
      };
    });
    console.log(formatTimingTable(record.tasks, record.fixture, rows).join("\n"));
    console.log("");
  }
  console.log(`Results: ${recordDirectory}`);
}

async function runDisk(options: {
  version: string;
  arguments: readonly string[];
  runner: Runner;
  repositoryRoot: string;
  resultsDirectory: string;
  workDirectory: string;
  install: InstallInfo;
  nodePath: string;
  nodeVersion: string;
}): Promise<void> {
  const fixturesDirectory = path.join(options.workDirectory, "fixtures");
  await mkdir(fixturesDirectory, { recursive: true });

  const sizes: Record<string, number> = {};
  for (const spec of DISK_FIXTURES) {
    sizes[spec.name] = await ensureFixture({
      spec,
      fixturesDirectory,
      workDirectory: options.workDirectory,
      coreIndex: options.install.coreIndex,
      nodePath: options.nodePath,
    });
  }

  const startedAt = new Date();
  const loadStart = await readLoadAverages(options.runner);
  const recordDirectory = await createRecordFolder(
    options.resultsDirectory,
    `disk-${options.version}`,
    startedAt,
  );
  const slopes = computeDiskSlopes(sizes);
  await writeJson(recordDirectory, "disk.json", { fixtures: sizes, ...slopes });

  const endedAt = new Date();
  const loadEnd = await readLoadAverages(options.runner);
  await writeMeta(
    recordDirectory,
    await buildMeta({
      mode: "disk",
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
    }),
  );

  for (const spec of DISK_FIXTURES) {
    console.log(`${spec.name}: ${sizes[spec.name]} bytes`);
  }
  console.log(`perTask: ${slopes.perTask} bytes`);
  console.log(`perComment: ${slopes.perComment} bytes`);
  console.log(`Results: ${recordDirectory}`);
}

async function buildMeta(options: MetaOptions): Promise<unknown> {
  return {
    mode: options.mode,
    version: options.version,
    arguments: options.arguments,
    repository: await readRepositoryState(options.runner, options.repositoryRoot),
    cli: options.install.cliVersion,
    core: options.install.coreVersion,
    node: {
      path: options.nodePath,
      version: options.nodeVersion,
    },
    hyperfine: await readHyperfineVersion(options.runner),
    system: await readSystemInfo(options.runner),
    loadAverages: {
      start: options.loadStart,
      end: options.loadEnd,
    },
    startedAt: options.startedAt.toISOString(),
    endedAt: options.endedAt.toISOString(),
  };
}

async function runHyperfine(
  runner: Runner,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  // Streamed, so each command's result reaches the terminal or session log as hyperfine prints it.
  const result = await runner.spawn(args, {
    cwd,
    onOutput: (output) => {
      const stream = output.stream === "stdout" ? process.stdout : process.stderr;
      stream.write(`${output.line}\n`);
    },
  }).done;
  if (result.exitCode !== 0) {
    throw new Error(`hyperfine failed with exit code ${result.exitCode}:\n${result.stderr.trim()}`);
  }
}

async function prepareScratchDatabase(
  scratch: string,
  runsDirectory: string,
  fixtureDatabase: string,
): Promise<void> {
  await removeRunDirectory(scratch, runsDirectory);
  await mkdir(path.join(scratch, "data"), { recursive: true });
  await copyFile(fixtureDatabase, path.join(scratch, "data", "zinn.sqlite"));
}

function listFiles(directory: string): FileEntry[] {
  const files: FileEntry[] = [];
  function walk(current: string, relative: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, entryRelative);
        continue;
      }
      if (entry.isFile()) {
        files.push({ path: entryRelative, bytes: statSync(entryPath).size });
      }
    }
  }
  walk(directory, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`measure failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
