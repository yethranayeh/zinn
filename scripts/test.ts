/** Runs `bun test` with the suite's settings, keeps each run's results in .test-results/ and prints a summary. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism, constants, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

// More CLI subprocesses at once make the timeout measure queueing instead of test work.
const MAX_CONCURRENT_TESTS = 4;
// Tests that start several CLI subprocesses need more than Bun's 5 second default.
const TEST_TIMEOUT_MS = 30_000;
const DEFAULT_TARGETS = ["packages", "scripts"];
const RESULTS_DIRECTORY = ".test-results";
const KEPT_RUNS = 10;
const LOCK_FILE = "full-run.lock";
const LOCK_POLL_INTERVAL_MS = 500;
// Below this many failures, mostly timeouts can still be real hangs worth reading one by one.
const MIN_FAILURES_FOR_LOAD_HINT = 3;
const RUN_ID_PATTERN = /^\d{8}-\d{6}-\d+$/;
const TEMP_ROOT_PREFIX = "zinn-tests-";
// bun test flags whose value can follow as a separate argument, so that argument is not a path filter.
const FLAGS_WITH_VALUES = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  "--preload",
]);

export type FailedTest = {
  file: string;
  line?: number;
  name: string;
  seconds: number;
  timedOut: boolean;
};
export type RunResults = { passed: number; failed: Array<FailedTest> };
type LockHolder = { pid: number; runId: string; startedAt: string; command: string };
type TestSelection = { arguments: Array<string>; wholeFile?: string };

/** Splits the script's own --failed option from the arguments passed on to bun test. */
export function readArguments(args: ReadonlyArray<string>) {
  let failedRun: string | undefined;
  let rerunFailed = false;
  const bunArguments: Array<string> = [];
  let hasTargets = false;
  let hasNamePattern = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--failed") {
      rerunFailed = true;
      if (RUN_ID_PATTERN.test(args[index + 1] ?? "")) {
        index++;
        failedRun = args[index];
      }
      continue;
    }
    if (argument.startsWith("--failed=")) {
      rerunFailed = true;
      failedRun = argument.slice("--failed=".length);
      continue;
    }
    bunArguments.push(argument);
    const isNamePattern = ["-t", "--test-name-pattern"].includes(argument.split("=")[0]!);
    hasNamePattern ||= isNamePattern;
    if (FLAGS_WITH_VALUES.has(argument) && index + 1 < args.length) {
      index++;
      bunArguments.push(args[index]!);
      continue;
    }
    if (!argument.startsWith("-")) {
      hasTargets = true;
    }
  }

  return {
    rerunFailed,
    failedRun,
    bunArguments,
    hasTargets,
    isFullRun: !rerunFailed && !hasTargets && !hasNamePattern,
  };
}

function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity: string) => {
    const named: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return named[entity.toLowerCase()]!;
  });
}

function readAttributes(text: string) {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of text.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[name!] = decodeXml(value!);
  }
  return attributes;
}

/** Reads passed and failed tests from Bun's JUnit report. Skipped and filtered-out tests count as neither. */
export function readJunit(xml: string): RunResults {
  const results: RunResults = { passed: 0, failed: [] };
  let current:
    | { attributes: Record<string, string>; failed: boolean; timedOut: boolean; skipped: boolean }
    | undefined;

  const finishTestCase = () => {
    if (current === undefined) {
      return;
    }
    if (current.failed) {
      results.failed.push({
        file: current.attributes.file ?? "",
        line: current.attributes.line === undefined ? undefined : Number(current.attributes.line),
        name: current.attributes.name ?? "",
        seconds: Number(current.attributes.time ?? 0),
        timedOut: current.timedOut,
      });
    } else if (!current.skipped) {
      results.passed++;
    }
    current = undefined;
  };

  // Quoted attribute values may contain ">", so a tag ends only after its last quoted value.
  const tags = /<(\/?)(testcase|failure|error|skipped)\b((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  for (const [, closing, tag, attributeText, selfClosing] of xml.matchAll(tags)) {
    if (tag === "testcase") {
      if (closing) {
        finishTestCase();
        continue;
      }
      current = {
        attributes: readAttributes(attributeText!),
        failed: false,
        timedOut: false,
        skipped: false,
      };
      if (selfClosing) {
        finishTestCase();
      }
      continue;
    }
    if (current === undefined || closing) {
      continue;
    }
    if (tag === "skipped") {
      current.skipped = true;
      continue;
    }
    current.failed = true;
    current.timedOut ||= readAttributes(attributeText!).type === "TimeoutError";
  }

  return results;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Selects failed tests within each file, or the whole file when a failure has no test location. */
export function failedTestArguments(failed: Array<FailedTest>): Array<TestSelection> {
  const files = new Map<string, Array<FailedTest>>();
  for (const test of failed) {
    const tests = files.get(test.file) ?? [];
    tests.push(test);
    files.set(test.file, tests);
  }
  return [...files].map(([file, tests]) => {
    const wholeFile = tests.some((test) => !test.line || test.name === "");
    const names = [...new Set(tests.map((test) => escapeRegExp(test.name)))];
    return {
      arguments: wholeFile ? [`./${file}`] : [`./${file}`, "--test-name-pattern", names.join("|")],
      wholeFile: wholeFile ? file : undefined,
    };
  });
}

/** Combines Bun reports while preserving each suite's test cases and failure details. */
export function mergeJunitReports(reports: Array<string>) {
  const totals = { tests: 0, assertions: 0, failures: 0, skipped: 0, time: 0 };
  const suites: Array<string> = [];
  for (const report of reports) {
    const root = /<testsuites\b((?:\s+[\w:-]+="[^"]*")*)\s*>([\s\S]*)<\/testsuites>/.exec(report);
    if (root === null) {
      throw new Error("Cannot combine a JUnit report without a testsuites root.");
    }
    const attributes = readAttributes(root[1]!);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += Number(attributes[key] ?? 0);
    }
    suites.push(root[2]!.trim());
  }
  const attributes = Object.entries(totals).map(([key, value]) => `${key}="${value}"`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" ${attributes}>\n${suites.join("\n")}\n</testsuites>\n`;
}

/** Run directories in .test-results/ beyond the newest `keep`, oldest first. */
export function runsToRemove(entries: Array<string>, keep: number) {
  const runs = entries.filter((entry) => RUN_ID_PATTERN.test(entry)).sort();
  return runs.slice(0, Math.max(0, runs.length - keep));
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes the temp roots in `base` that belong to runs whose process is gone. */
export function removeStaleTempRoots(base: string) {
  for (const entry of readdirSync(base)) {
    const runId = entry.startsWith(TEMP_ROOT_PREFIX) ? entry.slice(TEMP_ROOT_PREFIX.length) : "";
    if (!RUN_ID_PATTERN.test(runId)) {
      continue;
    }
    const pid = Number(runId.split("-")[2]);
    if (!isProcessAlive(pid)) {
      rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
}

function readLockHolder(lockPath: string): LockHolder | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder;
  } catch {
    // Missing, or not yet completely written by its creator.
    return undefined;
  }
}

/** Waits until no other full run holds the lock, then takes it. A lock whose process is gone is taken over. */
export async function acquireFullRunLock(
  lockPath: string,
  holder: LockHolder,
  onWait: (other: LockHolder) => void,
) {
  let announced = false;

  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx");
      writeSync(descriptor, JSON.stringify(holder));
      closeSync(descriptor);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const other = readLockHolder(lockPath);
    if (other !== undefined && !isProcessAlive(other.pid)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (other !== undefined && !announced) {
      onWait(other);
      announced = true;
    }
    await Bun.sleep(LOCK_POLL_INTERVAL_MS);
  }
}

export function releaseFullRunLock(lockPath: string, pid: number) {
  if (readLockHolder(lockPath)?.pid === pid) {
    rmSync(lockPath, { force: true });
  }
}

function createRunId(date: Date, pid: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${pid}`;
}

function quoteArgument(argument: string) {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}

function newestFinishedRun(resultsDirectory: string) {
  const runs = readdirSync(resultsDirectory)
    .filter((entry) => RUN_ID_PATTERN.test(entry))
    .sort()
    .reverse();
  return runs.find((run) => existsSync(join(resultsDirectory, run, "junit.xml")));
}

type Summary = {
  runId: string;
  results: RunResults | undefined;
  exitCode: number;
  signal: string | null;
  command: string;
  seconds: number;
  loadAtStart: number;
  loadAtEnd: number;
  resultsPath: string;
  wholeFileRetries?: Array<string>;
};

export function formatSummary(summary: Summary) {
  const { runId, results, exitCode, signal } = summary;
  const lines: Array<string> = [];
  const cpus = availableParallelism();

  if (signal !== null) {
    lines.push(
      `Test run ${runId} was stopped by ${signal}. Bun writes junit.xml only when a run finishes, so the console output in output.log is all there is.`,
    );
  } else if (results === undefined) {
    lines.push(
      `Test run ${runId} ended with exit code ${exitCode} and wrote no junit.xml. The console output is in output.log.`,
    );
  } else if (results.failed.length > 0) {
    lines.push(
      `Test run ${runId} failed: ${results.failed.length} failed, ${results.passed} passed.`,
    );
    for (const test of results.failed) {
      const outcome = test.timedOut ? "timed out" : "failed   ";
      lines.push(
        `  ${outcome}  ${test.file}${test.line ? `:${test.line}` : ""}  ${test.name} (${test.seconds.toFixed(1)} s)`,
      );
    }
    const timeouts = results.failed.filter((test) => test.timedOut).length;
    const mostlyTimeouts =
      results.failed.length >= MIN_FAILURES_FOR_LOAD_HINT && timeouts * 2 >= results.failed.length;
    if (mostlyTimeouts) {
      const peakLoad = Math.max(summary.loadAtStart, summary.loadAtEnd).toFixed(1);
      lines.push(
        `${timeouts} of the failures are timeouts (load average up to ${peakLoad} on ${cpus} CPUs). Timeouts often come from load rather than from the code: rerun the failed tests before reading them as bugs.`,
      );
    }
  } else if (exitCode !== 0) {
    lines.push(
      `Test run ${runId} failed outside any test (exit code ${exitCode}): ${results.passed} tests passed. The error is in output.log.`,
    );
  } else {
    lines.push(`Test run ${runId} passed: ${results.passed} tests.`);
  }

  for (const file of summary.wholeFileRetries ?? []) {
    lines.push(`Retried the whole file because a failure had no test name or source line: ${file}`);
  }
  lines.push(`Command: ${summary.command}`);
  lines.push(
    `Bun ${Bun.version}, ${summary.seconds.toFixed(1)} s, load average ${summary.loadAtStart.toFixed(1)} at start and ${summary.loadAtEnd.toFixed(1)} at end, ${cpus} CPUs.`,
  );
  const files = results === undefined ? "summary.txt, output.log" : "summary.txt, junit.xml, output.log";
  lines.push(`Results: ${summary.resultsPath}/ (${files})`);
  if (results !== undefined && results.failed.length > 0) {
    lines.push(`Rerun the failed tests: bun run test --failed=${runId}`);
  }
  return `${lines.join("\n")}\n`;
}

async function copyStream(
  stream: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
  logDescriptor: number,
) {
  for await (const chunk of stream) {
    target.write(chunk);
    writeSync(logDescriptor, chunk);
  }
}

async function main() {
  const repositoryDirectory = process.cwd();
  const resultsDirectory = join(repositoryDirectory, RESULTS_DIRECTORY);
  const args = process.argv.slice(2);
  const { rerunFailed, failedRun, bunArguments, hasTargets, isFullRun } = readArguments(args);
  mkdirSync(resultsDirectory, { recursive: true });

  const targetArguments: Array<string> = [];
  let selections: Array<TestSelection>;
  if (rerunFailed) {
    const run = failedRun ?? newestFinishedRun(resultsDirectory);
    const junitPath = run === undefined ? undefined : join(resultsDirectory, run, "junit.xml");
    if (junitPath === undefined || !existsSync(junitPath)) {
      const missing =
        run === undefined ? "No finished test run" : `Test run ${run} has no junit.xml`;
      console.error(`${missing} in ${RESULTS_DIRECTORY}/ to rerun.`);
      process.exitCode = 1;
      return;
    }
    const { failed } = readJunit(readFileSync(junitPath, "utf8"));
    if (failed.length === 0) {
      console.log(`Test run ${run} has no failed tests to rerun.`);
      return;
    }
    selections = failedTestArguments(failed);
  } else {
    if (!hasTargets) {
      targetArguments.push(...DEFAULT_TARGETS);
    }
    selections = [{ arguments: targetArguments }];
  }

  const runId = createRunId(new Date(), process.pid);
  const runDirectory = join(resultsDirectory, runId);
  const resultsPath = `${RESULTS_DIRECTORY}/${runId}`;
  for (const run of runsToRemove(readdirSync(resultsDirectory), KEPT_RUNS - 1)) {
    rmSync(join(resultsDirectory, run), { recursive: true, force: true });
  }
  mkdirSync(runDirectory);

  // Concurrent Bun startup stalls under the macOS per-user temp directory.
  const tempBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  removeStaleTempRoots(tempBase);
  const tempRoot = join(tempBase, `${TEMP_ROOT_PREFIX}${runId}`);
  mkdirSync(tempRoot);

  const command = ["bun run test", ...args.map(quoteArgument)].join(" ");
  const lockPath = join(resultsDirectory, LOCK_FILE);
  console.error(`Test run ${runId} keeps its results in ${resultsPath}/.`);
  if (isFullRun) {
    const holder = { pid: process.pid, runId, startedAt: new Date().toISOString(), command };
    await acquireFullRunLock(lockPath, holder, (other) => {
      console.error(
        `Waiting for full test run ${other.runId} (pid ${other.pid}, started ${other.startedAt}) to finish: ${other.command}`,
      );
    });
  }

  const junitPath = join(runDirectory, "junit.xml");
  const junitPaths = selections.map((_, index) => selections.length === 1
    ? junitPath
    : join(runDirectory, `junit-${index + 1}.xml`));
  const logDescriptor = openSync(join(runDirectory, "output.log"), "w");

  const loadAtStart = loadavg()[0]!;
  const startedAt = performance.now();
  let exitCode = 0;
  let signal: string | null = null;
  try {
    for (const [index, selection] of selections.entries()) {
      const bunCommand = [
        process.execPath,
        "test",
        `--timeout=${TEST_TIMEOUT_MS}`,
        `--max-concurrency=${MAX_CONCURRENT_TESTS}`,
        "--only-failures",
        "--reporter=junit",
        `--reporter-outfile=${junitPaths[index]}`,
        ...bunArguments,
        ...selection.arguments,
      ];
      writeSync(logDescriptor, `$ ${bunCommand.map(quoteArgument).join(" ")}\n`);
      const child = Bun.spawn(bunCommand, {
        cwd: repositoryDirectory,
        env: { ...process.env, TMPDIR: tempRoot, ZINN_TEST_RUNNER: "1" },
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      });
      const forwardSignal = (received: NodeJS.Signals) => {
        child.kill(received);
      };
      process.on("SIGINT", forwardSignal);
      process.on("SIGTERM", forwardSignal);
      try {
        await Promise.all([
          copyStream(child.stdout, process.stdout, logDescriptor),
          copyStream(child.stderr, process.stderr, logDescriptor),
          child.exited,
        ]);
      } finally {
        process.off("SIGINT", forwardSignal);
        process.off("SIGTERM", forwardSignal);
      }
      signal = child.signalCode;
      const childExitCode = child.exitCode ?? 128 + (constants.signals[signal as NodeJS.Signals] ?? 0);
      if (signal !== null) {
        exitCode = childExitCode;
        break;
      }
      exitCode ||= childExitCode;
    }
    if (signal === null && selections.length > 1 && junitPaths.every((path) => existsSync(path))) {
      writeFileSync(junitPath, mergeJunitReports(junitPaths.map((path) => readFileSync(path, "utf8"))));
    }
  } finally {
    closeSync(logDescriptor);
    rmSync(tempRoot, { recursive: true, force: true });
    if (isFullRun) {
      releaseFullRunLock(lockPath, process.pid);
    }
  }

  const summaryText = formatSummary({
    runId,
    results: existsSync(junitPath) ? readJunit(readFileSync(junitPath, "utf8")) : undefined,
    exitCode,
    signal,
    command,
    seconds: (performance.now() - startedAt) / 1000,
    loadAtStart,
    loadAtEnd: loadavg()[0]!,
    resultsPath,
    wholeFileRetries: selections.flatMap((selection) => selection.wholeFile ?? []),
  });
  writeFileSync(join(runDirectory, "summary.txt"), summaryText);
  process.stdout.write(`\n${summaryText}`);
  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main();
}
