import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "./test-isolation.ts";
import {
  acquireFullRunLock,
  readArguments,
  readJunit,
  releaseFullRunLock,
  removeStaleTempRoots,
  runsToRemove,
} from "./test.ts";

const SCRIPT_PATH = join(import.meta.dir, "test.ts");
const FIXTURE_TIMEOUT_MS = 50;
const sampleTests = `
import { test, expect } from "bun:test";
test("adds numbers", () => { expect(1 + 1).toBe(2); });
test("compares (strings)", () => { expect("a").toBe("b"); });
test("waits too long", async () => { await Bun.sleep(${FIXTURE_TIMEOUT_MS * 10}); }, ${FIXTURE_TIMEOUT_MS});
test.skip("is skipped", () => {});
`;

function withDirectory(run: (directory: string) => void | Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "zinn-test-runner-"));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function exitedProcessId() {
  const finished = Bun.spawn(["true"]);
  await finished.exited;
  return finished.pid;
}

test.each([
  { args: [], isFullRun: true, hasTargets: false },
  { args: ["packages/cli/tests/column.test.ts"], isFullRun: false, hasTargets: true },
  { args: ["-t", "column create"], isFullRun: false, hasTargets: false },
  { args: ["--test-name-pattern=column create"], isFullRun: false, hasTargets: false },
  { args: ["--seed", "379", "--randomize"], isFullRun: true, hasTargets: false },
  { args: ["--failed"], isFullRun: false, hasTargets: false },
])("arguments $args select a full run: $isFullRun", ({ args, isFullRun, hasTargets }) => {
  const selected = readArguments(args);
  expect(selected.isFullRun).toBe(isFullRun);
  expect(selected.hasTargets).toBe(hasTargets);
  expect(selected.bunArguments).toEqual(args.filter((argument) => argument !== "--failed"));
});

test("--failed takes a run id joined or as the next argument", () => {
  expect(readArguments(["--failed=20261101-114112-42"])).toMatchObject({ rerunFailed: true, failedRun: "20261101-114112-42" });
  expect(readArguments(["--failed", "20261101-114112-42", "--bail"])).toMatchObject({
    rerunFailed: true,
    failedRun: "20261101-114112-42",
    bunArguments: ["--bail"],
  });
});

test("Bun's JUnit report yields failed tests with location and timeout, and passed tests", withDirectory((directory) => {
  writeFileSync(join(directory, "sample.test.ts"), sampleTests);
  Bun.spawnSync([process.execPath, "test", "--reporter=junit", "--reporter-outfile=junit.xml", "./sample.test.ts"], {
    cwd: directory,
    env: TEST_ENVIRONMENT,
  });

  const results = readJunit(readFileSync(join(directory, "junit.xml"), "utf8"));

  expect(results.passed).toBe(1);
  expect(results.failed.map(({ file, line, name, timedOut }) => ({ file, line, name, timedOut }))).toEqual([
    { file: "sample.test.ts", line: 4, name: "compares (strings)", timedOut: false },
    { file: "sample.test.ts", line: 5, name: "waits too long", timedOut: true },
  ]);
}));

test("a run keeps its results and summary, and --failed reruns only the failed tests", withDirectory((directory) => {
  writeFileSync(join(directory, "sample.test.ts"), sampleTests);
  const runScript = (args: Array<string>) =>
    Bun.spawnSync([process.execPath, SCRIPT_PATH, ...args], { cwd: directory, env: TEST_ENVIRONMENT });

  const first = runScript(["./sample.test.ts"]);
  const firstRuns = readdirSync(join(directory, ".test-results"));
  const firstRun = firstRuns[0]!;
  const firstSummary = first.stdout.toString();

  expect(first.exitCode).toBe(1);
  expect(firstRuns).toHaveLength(1);
  for (const file of ["junit.xml", "output.log", "summary.txt"]) {
    expect(existsSync(join(directory, ".test-results", firstRun, file))).toBe(true);
  }
  expect(firstSummary.endsWith(readFileSync(join(directory, ".test-results", firstRun, "summary.txt"), "utf8"))).toBe(true);
  expect(readFileSync(join(directory, ".test-results", firstRun, "output.log"), "utf8")).toContain("compares (strings)");
  for (const fact of ["sample.test.ts:4", "compares (strings)", "sample.test.ts:5", "waits too long", `--failed=${firstRun}`]) {
    expect(firstSummary).toContain(fact);
  }
  expect(existsSync(join("/private/tmp", `zinn-tests-${firstRun}`))).toBe(false);
  expect(existsSync(join(tmpdir(), `zinn-tests-${firstRun}`))).toBe(false);

  const rerun = runScript([`--failed=${firstRun}`]);
  const rerunRun = readdirSync(join(directory, ".test-results")).find((entry) => entry !== firstRun)!;
  const rerunResults = readJunit(readFileSync(join(directory, ".test-results", rerunRun, "junit.xml"), "utf8"));

  expect(rerun.exitCode).toBe(1);
  expect(rerunResults.passed).toBe(0);
  expect(rerunResults.failed.map((failed) => failed.name)).toEqual(["compares (strings)", "waits too long"]);
}));

test("a bare --failed reruns the newest finished run, and a run without failures has nothing to rerun", withDirectory((directory) => {
  writeFileSync(join(directory, "passing.test.ts"), 'import { test } from "bun:test";\ntest("passes", () => {});\n');
  const runScript = (args: Array<string>) =>
    Bun.spawnSync([process.execPath, SCRIPT_PATH, ...args], { cwd: directory, env: TEST_ENVIRONMENT });

  const missing = runScript(["--failed"]);
  expect(missing.exitCode).toBe(1);

  expect(runScript(["./passing.test.ts"]).exitCode).toBe(0);
  const nothingFailed = runScript(["--failed"]);
  expect(nothingFailed.exitCode).toBe(0);
  expect(readdirSync(join(directory, ".test-results"))).toHaveLength(1);
}));

test("--failed retries a setup failure's file and keeps other files filtered to their own failures", withDirectory((directory) => {
  writeFileSync(join(directory, "setup.test.ts"), `
    import { beforeAll, test } from "bun:test";
    import { existsSync, writeFileSync } from "node:fs";
    beforeAll(() => {
      if (!existsSync("setup-ready")) { throw new Error("SETUP_FAILURE"); }
    });
    test("first setup-dependent case", () => { writeFileSync("setup-first-ran", ""); });
    test("second setup-dependent case", () => { writeFileSync("setup-second-ran", ""); });
  `);
  writeFileSync(join(directory, "named-a.test.ts"), `
    import { expect, test } from "bun:test";
    import { existsSync, writeFileSync } from "node:fs";
    test("(unnamed)", () => { expect(existsSync("tests-ready")).toBe(true); });
    test("other failure", () => { writeFileSync("named-a-passed", ""); });
  `);
  writeFileSync(join(directory, "named-b.test.ts"), `
    import { expect, test } from "bun:test";
    import { existsSync, writeFileSync } from "node:fs";
    test("other failure", () => { expect(existsSync("tests-ready")).toBe(true); });
    test("(unnamed)", () => { writeFileSync("named-b-passed", ""); });
  `);
  const resultsDirectory = join(directory, ".test-results");
  const runScript = (args: Array<string>) => {
    const previousRuns = existsSync(resultsDirectory) ? readdirSync(resultsDirectory) : [];
    const result = Bun.spawnSync([process.execPath, SCRIPT_PATH, ...args], {
      cwd: directory,
      env: TEST_ENVIRONMENT,
    });
    const run = readdirSync(resultsDirectory).find((entry) => !previousRuns.includes(entry))!;
    const runDirectory = join(resultsDirectory, run);
    const xml = readFileSync(join(runDirectory, "junit.xml"), "utf8");
    for (const file of ["junit.xml", "output.log", "summary.txt"]) {
      expect(existsSync(join(runDirectory, file))).toBe(true);
    }
    expect(result.stdout.toString()).toContain(readFileSync(join(runDirectory, "summary.txt"), "utf8"));
    expect(xml.match(/<testsuites\b/g)).toHaveLength(1);
    const root = /<testsuites\b([^>]*)>/.exec(xml)![1]!;
    const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)].map((match) => match[1]!);
    for (const key of ["tests", "assertions", "failures", "skipped"]) {
      const attribute = new RegExp(`\\b${key}="([^"]*)"`);
      const total = suites.reduce((sum, suite) => sum + Number(attribute.exec(suite)![1]), 0);
      expect(Number(attribute.exec(root)![1])).toBe(total);
    }
    return { run, exitCode: result.exitCode, results: readJunit(xml) };
  };

  const first = runScript(["./setup.test.ts", "./named-a.test.ts", "./named-b.test.ts"]);
  expect(first.exitCode).toBe(1);
  expect(first.results.passed).toBe(2);
  expect(first.results.failed).toHaveLength(3);
  expect(first.results.failed.find((test) => test.file === "setup.test.ts")?.line).toBeUndefined();
  expect(first.results.failed.find((test) => test.file === "named-a.test.ts")).toMatchObject({ name: "(unnamed)", line: 4 });
  rmSync(join(directory, "named-a-passed"));
  rmSync(join(directory, "named-b-passed"));

  const stillBroken = runScript([`--failed=${first.run}`]);
  expect(stillBroken.exitCode).toBe(1);
  expect(stillBroken.results.passed).toBe(0);
  expect(stillBroken.results.failed.map((test) => test.file).sort()).toEqual(["named-a.test.ts", "named-b.test.ts", "setup.test.ts"]);

  writeFileSync(join(directory, "tests-ready"), "");
  const setupStillBroken = runScript([`--failed=${first.run}`]);
  expect(setupStillBroken.exitCode).toBe(1);
  expect(setupStillBroken.results.passed).toBe(2);
  expect(setupStillBroken.results.failed.map((test) => test.file)).toEqual(["setup.test.ts"]);

  writeFileSync(join(directory, "setup-ready"), "");
  const fixed = runScript([`--failed=${first.run}`]);
  expect(fixed.exitCode).toBe(0);
  expect(fixed.results).toEqual({ passed: 4, failed: [] });
  expect(existsSync(join(directory, "setup-first-ran"))).toBe(true);
  expect(existsSync(join(directory, "setup-second-ran"))).toBe(true);
  for (const marker of ["named-a-passed", "named-b-passed"]) {
    expect(existsSync(join(directory, marker))).toBe(false);
  }
}));

test("--failed reruns a file after its setup recovers", withDirectory((directory) => {
  writeFileSync(join(directory, "setup.test.ts"), `
    import { beforeAll, test } from "bun:test";
    import { existsSync, writeFileSync } from "node:fs";
    beforeAll(() => {
      if (!existsSync("ready")) { throw new Error("SETUP_FAILURE"); }
    });
    test("runs after setup", () => { writeFileSync("test-ran", ""); });
  `);
  const runScript = (args: Array<string>) =>
    Bun.spawnSync([process.execPath, SCRIPT_PATH, ...args], { cwd: directory, env: TEST_ENVIRONMENT });
  expect(runScript(["./setup.test.ts"]).exitCode).toBe(1);
  expect(existsSync(join(directory, "test-ran"))).toBe(false);
  writeFileSync(join(directory, "ready"), "");

  const rerun = runScript(["--failed"]);

  expect(rerun.exitCode).toBe(0);
  expect(existsSync(join(directory, "test-ran"))).toBe(true);
  const newest = readdirSync(join(directory, ".test-results")).sort().at(-1)!;
  expect(readJunit(readFileSync(join(directory, ".test-results", newest, "junit.xml"), "utf8"))).toEqual({ passed: 1, failed: [] });
}));

test("only the newest run directories are kept", () => {
  const runs = Array.from({ length: 12 }, (_, index) => `20261101-1000${String(index).padStart(2, "0")}-7`);
  const entries = [...runs].reverse().concat(["full-run.lock", "notes"]);

  expect(runsToRemove(entries, 9)).toEqual(runs.slice(0, 3));
  expect(runsToRemove(runs.slice(0, 4), 9)).toEqual([]);
});

test("stale temp roots of finished runs are removed, and live ones and other directories stay", withDirectory(async (base) => {
  const deadRun = `zinn-tests-20261101-100000-${await exitedProcessId()}`;
  const liveRun = `zinn-tests-20261101-100000-${process.pid}`;
  for (const entry of [deadRun, liveRun, "zinn-test-run-abc123", "zinn-tests-notes"]) {
    mkdirSync(join(base, entry));
  }

  removeStaleTempRoots(base);

  expect(readdirSync(base).sort()).toEqual([liveRun, "zinn-test-run-abc123", "zinn-tests-notes"].sort());
}));

test("a full run waits for a live holder of the lock and takes over a lock whose process is gone", withDirectory(async (directory) => {
  const lockPath = join(directory, "full-run.lock");
  const holder = { pid: process.pid, runId: "20261101-100000-1", startedAt: "2026-11-01T10:00:00.000Z", command: "bun run test" };

  writeFileSync(lockPath, JSON.stringify({ ...holder, pid: await exitedProcessId() }));
  await acquireFullRunLock(lockPath, holder, () => {
    throw new Error("waited for a finished run");
  });
  expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  releaseFullRunLock(lockPath, process.pid);
  expect(existsSync(lockPath)).toBe(false);

  const otherRun = Bun.spawn(["sleep", "30"]);
  writeFileSync(lockPath, JSON.stringify({ ...holder, pid: otherRun.pid }));
  const waitedFor: Array<number> = [];
  let acquired = false;
  const acquiring = acquireFullRunLock(lockPath, holder, (other) => waitedFor.push(other.pid)).then(() => {
    acquired = true;
  });
  await Bun.sleep(100);

  expect(waitedFor).toEqual([otherRun.pid]);
  expect(acquired).toBe(false);
  releaseFullRunLock(lockPath, process.pid);
  expect(existsSync(lockPath)).toBe(true);

  otherRun.kill();
  await otherRun.exited;
  await acquiring;
  expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
}));
