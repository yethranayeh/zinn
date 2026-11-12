import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutputFileName } from "@zinn-dev/core";
import { MIGRATIONS, latestVersion } from "../../core/src/migrations/registry";
import packageJson from "../package.json";
import { runProcessAsync } from "../testing";
import { errorDocumentSchema } from "./errors";

const CLI_PATH = new URL("../index.ts", import.meta.url).pathname;
const LIB_PATH = new URL("./lib.ts", import.meta.url).pathname;
const LOG_EXTENSION = ".log";
const KEPT_LOG_COUNT = 10;
const CONCURRENT_FAILURES = 6;
const OLD_LOG_COUNT = 12;
const OVERFLOWING_FAILURES = 16;
const NEWEST_LOG_TIME_SECONDS = 1_600_000_000;
const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);

const stores: Array<string> = [];

afterAll(() => {
  for (const store of stores.splice(0)) {
    rmSync(store, { recursive: true, force: true });
  }
});

function newStore() {
  const store = mkdtempSync(join(tmpdir(), "zinn-failure-log-"));
  stores.push(store);
  return store;
}

function runEnvironment(store: string, env: Record<string, string | undefined> = {}) {
  return { ...TEST_ENVIRONMENT, ZINN_DIR: store, ZINN_DEBUG: undefined, ...env };
}

/** Runs a command and keeps its process ID, which a failure log records. */
async function runKeepingPid(command: Array<string>, options: { cwd: string; env: Record<string, string | undefined> }) {
  const proc = Bun.spawn(command, { ...options, stdout: "pipe", stderr: "pipe" });
  const [, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { code: proc.exitCode, stdout, stderr, pid: proc.pid };
}

async function run(
  store: string,
  args: Array<string>,
  options: { env?: Record<string, string | undefined>; cwd?: string } = {},
) {
  return runKeepingPid([process.execPath, CLI_PATH, ...args], {
    cwd: options.cwd ?? store,
    env: runEnvironment(store, options.env),
  });
}

/** Renders a failure from a throwaway process, after a notice, as the CLI does for an unexpected error. */
async function runRendering(
  expression: string,
  options: {
    json?: boolean;
    cwd: string;
    env: Record<string, string | undefined>;
  },
) {
  const script = `
    import { prepareOutput, diagnostic, renderFailure } from ${JSON.stringify(LIB_PATH)};
    prepareOutput(${JSON.stringify(options.json === true ? ["--json"] : [])});
    diagnostic("notice before the failure");
    renderFailure(${expression});
  `;
  return runKeepingPid([process.execPath, "--eval", script], {
    cwd: options.cwd,
    env: options.env,
  });
}

const INTERNAL_FAILURE = "new Error('outer failure', { cause: new Error('inner cause') })";

/** Renders in a throwaway process whose store is the given folder. */
function renderIn(store: string, expression: string, json = false) {
  return runRendering(expression, { json, cwd: store, env: runEnvironment(store) });
}

function corruptStore() {
  const store = newStore();
  mkdirSync(join(store, "data"));
  writeFileSync(join(store, "data", "zinn.sqlite"), "not a SQLite database");
  return store;
}

async function healthyStore() {
  const store = newStore();
  expect((await run(store, ["project", "create", "APP"])).code).toBe(0);
  expect((await run(store, ["task", "create", "APP", "--title", "Kept"])).code).toBe(0);
  return store;
}

function logNames(store: string) {
  const logs = join(store, "logs");
  return existsSync(logs) ? readdirSync(logs).sort() : [];
}

function logPaths(store: string) {
  return logNames(store).map((name) => join(store, "logs", name));
}

function parseFailure(result: { code: number | null; stdout: string; stderr: string }) {
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  return errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
}

function lines(text: string) {
  return text.trimEnd().split("\n");
}

test("invalid input, missing items, conflicts and successful commands write no log", async () => {
  const store = await healthyStore();
  const cases = [
    { args: ["task", "create", "APP"], code: "invalid_input" },
    { args: ["task", "view", "APP-99"], code: "not_found" },
    { args: ["project", "create", "APP"], code: "conflict" },
  ];

  for (const { args, code } of cases) {
    expect(parseFailure(await run(store, [...args, "--json"])), args.join(" ")).toMatchObject({ code });
    expect((await run(store, args)).code, args.join(" ")).toBe(1);
  }
  expect((await run(store, ["task", "list", "APP"])).code).toBe(0);
  expect(existsSync(join(store, "logs"))).toBe(false);
});

test("a storage failure writes one log that the text and JSON errors name", async () => {
  const textStore = corruptStore();
  const text = await run(textStore, ["project", "list"]);

  expect(text.code).toBe(1);
  expect(text.stdout).toBe("");
  const [textName] = logNames(textStore);
  expect(logNames(textStore)).toHaveLength(1);
  expect(readOutputFileName(textName!, LOG_EXTENSION)).toEqual({
    client: "cli",
    version: packageJson.version,
  });
  expect(lines(text.stderr).at(-1)).toContain(join(textStore, "logs", textName!));

  const jsonStore = corruptStore();
  const error = parseFailure(await run(jsonStore, ["project", "list", "--json"]));

  expect(error).toMatchObject({ code: "storage", details: { reason: "not_database" } });
  expect(logPaths(jsonStore)).toHaveLength(1);
  expect(error.details?.logPath).toBe(logPaths(jsonStore)[0]!);
});

test("an unexpected error writes one log and gets details when it had none", async () => {
  const textStore = await healthyStore();
  const text = await renderIn(textStore, INTERNAL_FAILURE);

  expect(text.code).toBe(1);
  expect(text.stdout).toBe("");
  expect(logPaths(textStore)).toHaveLength(1);
  expect(readOutputFileName(logNames(textStore)[0]!, LOG_EXTENSION)).not.toBeNull();
  expect(lines(text.stderr).at(-1)).toContain(logPaths(textStore)[0]!);

  const jsonStore = await healthyStore();
  const error = parseFailure(await renderIn(jsonStore, INTERNAL_FAILURE, true));

  expect(logPaths(jsonStore)).toHaveLength(1);
  expect(error.code).toBe("internal");
  expect(error.details).toEqual({ logPath: logPaths(jsonStore)[0]! });
});

test("the manifest lists logPath among the error details", async () => {
  const result = await run(newStore(), ["capabilities", "--json"]);
  const details = JSON.parse(result.stdout).schemas.definitions.ErrorEnvelope.properties.error
    .properties.details.properties;

  expect(result.code, result.stderr).toBe(0);
  expect(details.logPath).toEqual({ type: "string" });
});

test("the log holds the error chain, the run, the store, the arguments typed and the notices", async () => {
  const store = corruptStore();
  const args = ["task", "create", "APP", "--title", "Title", "--description", "two words\nand a line break"];
  const result = await run(store, [...args, "--json"]);
  const error = parseFailure(result);
  const log = readFileSync(logPaths(store)[0]!, "utf8");

  expect(log).toContain(error.message);
  expect(log).toContain(error.details!.cause!.message);
  expect(log).toContain(error.details!.cause!.code!);
  expect(log).toMatch(/\n\s+at /);
  expect(log).toContain(String(result.pid));
  expect(log).toContain(packageJson.version);
  expect(log).toContain(store);
  expect(log).toContain(join(realpathSync(store), "data", "zinn.sqlite"));
  expect(log).toContain(JSON.stringify([...args, "--json"]));
  expect(lines(log).find((line) => /schema version/i.test(line))).toContain("unknown");
});

test("the log of a healthy store names its schema version, and keeps notices, causes and suppressed errors", async () => {
  const store = await healthyStore();
  const expression = `Object.assign(
    new Error('outer failure', { cause: new Error('inner cause') }),
    { code: 'EXAMPLE', suppressed: new Error('cleanup also failed') },
  )`;
  const result = await renderIn(store, expression);
  const log = readFileSync(logPaths(store)[0]!, "utf8");

  expect(result.code).toBe(1);
  for (const fact of ["outer failure", "inner cause", "cleanup also failed", "EXAMPLE"]) {
    expect(log).toContain(fact);
  }
  expect(log).toContain("notice before the failure");
  expect(log).toContain(String(result.pid));
  expect(log).toContain(store);
  expect(lines(log).find((line) => /schema version/i.test(line))).toContain(String(CURRENT_SCHEMA_VERSION));
});

test("a dangling backups link leaves healthy commands working, and a failed backup's log names the schema version", async () => {
  const store = await healthyStore();
  symlinkSync(join(store, "nowhere"), join(store, "backups"));

  expect((await run(store, ["task", "list"])).code).toBe(0);

  const error = parseFailure(await run(store, ["backup", "--json"]));
  const log = readFileSync(error.details!.logPath!, "utf8");

  expect(error).toMatchObject({
    code: "storage",
    details: { entity: "backup", backupDirectory: join(store, "backups") },
  });
  expect(error.message).toContain(join(store, "backups"));
  expect(error.message).not.toContain("Cannot resolve the database path");
  expect(lines(log).find((line) => /schema version/i.test(line))).toContain(String(CURRENT_SCHEMA_VERSION));
  expect(existsSync(join(store, "nowhere"))).toBe(false);
});

test("the log prints a thrown string and stops at an error chain that repeats", async () => {
  const cases = [
    { expression: "'a thrown string'", fact: "a thrown string" },
    {
      expression: "(() => { const error = new Error('loops back'); error.cause = error; return error; })()",
      fact: "loops back",
    },
  ];

  for (const { expression, fact } of cases) {
    const store = await healthyStore();
    const result = await renderIn(store, expression);

    expect(result.code, result.stderr).toBe(1);
    const log = readFileSync(logPaths(store)[0]!, "utf8");
    expect(log).toContain(fact);
    expect(log.split(fact).length - 1, expression).toBe(1);
  }
});

test("ZINN_DEBUG=1 puts the route detail in the log and without it the log has none", async () => {
  const debugged = corruptStore();
  const debugDetail = parseFailure(
    await run(debugged, ["project", "list", "--json"], { env: { ZINN_DEBUG: "1" } }),
  ).diagnostics;
  const debugLog = readFileSync(logPaths(debugged)[0]!, "utf8");

  expect(debugDetail?.length).toBeGreaterThan(0);
  for (const entry of debugDetail!) {
    expect(debugLog).toContain(entry);
  }

  const plain = corruptStore();
  const plainError = parseFailure(await run(plain, ["project", "list", "--json"]));
  const plainLog = readFileSync(logPaths(plain)[0]!, "utf8");

  expect(plainError.diagnostics).toBeUndefined();
  for (const entry of debugDetail!) {
    expect(plainLog).not.toContain(entry);
  }
});

test("failures that run at once write separate, complete logs", async () => {
  const store = corruptStore();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_FAILURES }, () =>
      runProcessAsync([process.execPath, CLI_PATH, "project", "list", "--json"], {
        env: runEnvironment(store),
        cwd: store,
      }),
    ),
  );
  const named = results.map((result) => {
    expect(result.code, result.stderr).toBe(1);
    return errorDocumentSchema.parse(JSON.parse(result.stderr)).error.details!.logPath!;
  });

  expect(new Set(named).size).toBe(CONCURRENT_FAILURES);
  expect(logPaths(store).sort()).toEqual([...named].sort());
  for (const path of logPaths(store)) {
    expect(statSync(path).size).toBeGreaterThan(0);
  }
});

test("a failing run keeps the newest ten logs and leaves other files alone", async () => {
  const store = corruptStore();
  const logs = join(store, "logs");
  mkdirSync(logs);
  const oldNames = Array.from({ length: OLD_LOG_COUNT }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const suffix = String(index).padStart(8, "0");
    return `2020-01-${day}T00-00-00Z-cli-0.1.0-${suffix}${LOG_EXTENSION}`;
  });
  const otherFiles = { "notes.txt": "keep me", "not-named-by-zinn.log": "keep me too" };
  for (const name of oldNames) {
    expect(readOutputFileName(name, LOG_EXTENSION), name).not.toBeNull();
    writeFileSync(join(logs, name), "old log");
  }
  for (const [name, content] of Object.entries(otherFiles)) {
    writeFileSync(join(logs, name), content);
  }

  const error = parseFailure(await run(store, ["project", "list", "--json"]));
  const remaining = logNames(store).filter((name) => readOutputFileName(name, LOG_EXTENSION) !== null);

  expect(remaining).toHaveLength(KEPT_LOG_COUNT);
  expect(remaining.slice(0, KEPT_LOG_COUNT - 1)).toEqual(oldNames.slice(OLD_LOG_COUNT - (KEPT_LOG_COUNT - 1)));
  expect(error.details?.logPath).toBe(join(logs, remaining.at(-1)!));
  expect(existsSync(error.details!.logPath!)).toBe(true);
  for (const [name, content] of Object.entries(otherFiles)) {
    expect(readFileSync(join(logs, name), "utf8")).toBe(content);
  }
});

test("logs written in the same second are kept by modification time, not by name", async () => {
  const store = corruptStore();
  const logs = join(store, "logs");
  mkdirSync(logs);
  const oldNames = Array.from({ length: OLD_LOG_COUNT }, (_, index) => {
    const suffix = String(index).padStart(8, "0");
    return `2020-01-01T00-00-00Z-cli-0.1.0-${suffix}${LOG_EXTENSION}`;
  });
  // The names sort opposite to their times, so the first name is the newest log.
  for (const [index, name] of oldNames.entries()) {
    const path = join(logs, name);
    const seconds = NEWEST_LOG_TIME_SECONDS - index;
    writeFileSync(path, "old log");
    utimesSync(path, seconds, seconds);
  }

  const error = parseFailure(await run(store, ["project", "list", "--json"]));
  const newestOld = oldNames.slice(0, KEPT_LOG_COUNT - 1);

  expect(logNames(store).filter((name) => oldNames.includes(name))).toEqual(newestOld);
  expect(logPaths(store)).toContain(error.details!.logPath!);
  expect(logNames(store)).toHaveLength(KEPT_LOG_COUNT);
});

test("more failures at once than the limit leave at most ten complete logs", async () => {
  const store = corruptStore();
  const results = await Promise.all(
    Array.from({ length: OVERFLOWING_FAILURES }, () =>
      runProcessAsync([process.execPath, CLI_PATH, "project", "list", "--json"], {
        env: runEnvironment(store),
        cwd: store,
      }),
    ),
  );

  for (const result of results) {
    expect(result.code, result.stderr).toBe(1);
  }
  const paths = logPaths(store);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.length).toBeLessThanOrEqual(KEPT_LOG_COUNT);
  for (const path of paths) {
    const log = readFileSync(path, "utf8");
    expect(log.startsWith("Error\n"), path).toBe(true);
    expect(log.endsWith("\n"), path).toBe(true);
  }
});

/** The stderr lines of a failure whose log was written, without the line that names the log. */
async function textFailureWithoutLogLine() {
  const text = await run(corruptStore(), ["project", "list"]);
  expect(text.code).toBe(1);
  return lines(text.stderr).slice(0, -1);
}

test("a logs path that is a file leaves the original error and exit code unchanged", async () => {
  const store = corruptStore();
  writeFileSync(join(store, "logs"), "not a folder");
  const text = await run(store, ["project", "list"]);
  const error = parseFailure(await run(store, ["project", "list", "--json"]));

  expect(text.code).toBe(1);
  expect(lines(text.stderr)).toEqual(await textFailureWithoutLogLine());
  expect(error).toMatchObject({ code: "storage", details: { reason: "not_database" } });
  expect(error.details?.logPath).toBeUndefined();
  expect(readFileSync(join(store, "logs"), "utf8")).toBe("not a folder");
});

const isRoot = process.getuid?.() === 0;
const canRestrictFolders = process.platform !== "win32" && !isRoot;

test.skipIf(!canRestrictFolders)("a read-only logs folder leaves the original error and exit code unchanged", async () => {
  const store = corruptStore();
  const logs = join(store, "logs");
  mkdirSync(logs);
  chmodSync(logs, 0o555);

  try {
    const text = await run(store, ["project", "list"]);
    const error = parseFailure(await run(store, ["project", "list", "--json"]));

    expect(text.code).toBe(1);
    expect(lines(text.stderr)).toEqual(await textFailureWithoutLogLine());
    expect(error).toMatchObject({ code: "storage", details: { reason: "not_database" } });
    expect(error.details?.logPath).toBeUndefined();
    expect(readdirSync(logs)).toEqual([]);
  } finally {
    chmodSync(logs, 0o755);
  }
});

test.skipIf(!canRestrictFolders)("a text file that cannot be read keeps its cause in the log", async () => {
  const store = await healthyStore();
  const path = join(store, "unreadable.md");
  writeFileSync(path, "text");
  chmodSync(path, 0o000);

  const error = parseFailure(
    await run(store, ["task", "create", "APP", "--title", "Title", "--description-file", path, "--json"]),
  );

  expect(error.details?.cause?.code).toBe("EACCES");
  expect(readFileSync(error.details!.logPath!, "utf8")).toContain("EACCES");
});

test.skipIf(process.platform === "win32")("a dangling logs link leaves the original error, and healthy commands succeed", async () => {
  const broken = corruptStore();
  symlinkSync(join(broken, "nowhere"), join(broken, "logs"));
  const text = await run(broken, ["project", "list"]);
  const error = parseFailure(await run(broken, ["project", "list", "--json"]));

  expect(text.code).toBe(1);
  expect(lines(text.stderr)).toEqual(await textFailureWithoutLogLine());
  expect(error).toMatchObject({ code: "storage", details: { reason: "not_database" } });
  expect(error.details?.logPath).toBeUndefined();
  expect(existsSync(join(broken, "nowhere"))).toBe(false);

  const healthy = await healthyStore();
  symlinkSync(join(healthy, "nowhere"), join(healthy, "logs"));
  const listed = await run(healthy, ["project", "list", "--json"]);

  expect(listed.code, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)[0].key).toBe("APP");
});

test("a store folder that does not exist gets no log and is not created", async () => {
  const parent = newStore();
  const missing = join(parent, "missing");
  const options = { cwd: parent };
  const text = await run(missing, ["project", "list"], options);
  const error = parseFailure(await run(missing, ["project", "list", "--json"], options));

  expect(text.code).toBe(1);
  expect(error).toMatchObject({ code: "storage", details: { reason: "invalid_storage" } });
  expect(error.details?.logPath).toBeUndefined();
  expect(existsSync(missing)).toBe(false);
  expect(readdirSync(parent)).toEqual([]);
});

test("a data path that cannot be resolved still writes a log in the store's folder", async () => {
  const store = newStore();
  writeFileSync(join(store, "data"), "not a folder");
  const error = parseFailure(await run(store, ["project", "list", "--json"]));

  expect(error.code).toBe("storage");
  expect(logPaths(store)).toEqual([error.details!.logPath!]);
  expect(readFileSync(error.details!.logPath!, "utf8")).toContain(join(store, "data", "zinn.sqlite"));
});

test("a missing default store is not created to hold a log", async () => {
  const home = newStore();
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: home, USERPROFILE: home };
  delete env.ZINN_DIR;
  const result = await runRendering(INTERNAL_FAILURE, { cwd: home, env });
  const json = await runRendering(INTERNAL_FAILURE, { cwd: home, env, json: true });

  expect(result.code).toBe(1);
  expect(lines(result.stderr).some((line) => line.includes("outer failure"))).toBe(true);
  expect(parseFailure(json).details?.logPath).toBeUndefined();
  expect(existsSync(join(home, ".zinn"))).toBe(false);
});
