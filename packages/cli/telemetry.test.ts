import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BYTES_PER_MEGABYTE } from "@zinn-dev/core";

import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import packageJson from "./package.json" with { type: "json" };
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir } from "./test-helpers";

type Run = { code: number | null; stdout: string; stderr: string };

const SECRET_TITLE = "secret-title-value";
const SECRET_KEY = "SECRETKEY-1";
const RECORD_FILE_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/;
const MILLISECONDS_PER_DAY = 86_400_000;
/** Folder modes do not bind for root or on Windows */
const doFolderModesBind = process.platform !== "win32" && process.getuid?.() !== 0;

function telemetryFolder(store: string) {
  return join(store, "telemetry");
}

/** Every record in the store, in the order written. Parsing throws on a torn line. */
function readRecords(store: string): Array<any> {
  const folder = telemetryFolder(store);
  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RECORD_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => readFileSync(join(folder, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
}

function lastRecord(store: string) {
  return readRecords(store).at(-1);
}

async function createProject(store: string) {
  expect((await runZinn(["project", "create", "APP"], store)).code).toBe(0);
}

function corruptDatabase(store: string) {
  mkdirSync(join(store, "data"));
  writeFileSync(join(store, "data", "zinn.sqlite"), "not a SQLite database");
}

function expectOneMore(store: string, before: number) {
  expect(readRecords(store)).toHaveLength(before + 1);
  return lastRecord(store);
}

function expectSameResult(result: Run, expected: Run) {
  expect(result.code).toBe(expected.code);
  expect(result.stdout).toBe(expected.stdout);
  expect(result.stderr).toBe(expected.stderr);
}

describe("telemetry record", () => {
  test("a successful write and read carry the run's facts", async () => {
    await withIsolatedZinnDir(async (store) => {
      await createProject(store);
      const created = lastRecord(store);
      const startedOn = created.startedAt.slice(0, 10);

      expect(readdirSync(telemetryFolder(store))).toEqual([`${startedOn}-0001.jsonl`]);
      expect(created).toMatchObject({
        v: 1,
        exitCode: 0,
        actor: { kind: "human", client: `zinn-cli/${packageJson.version}` },
        command: { route: "project create", help: false },
        options: [],
        positionals: 1,
        version: packageJson.version,
        runtime: { name: "Bun", version: process.versions.bun },
        platform: process.platform,
        arch: process.arch,
        stdinIsTerminal: false,
        stdoutIsTerminal: false,
      });
      expect(created.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isInteger(created.durationMs)).toBe(true);
      expect(Number.isInteger(created.parentPid)).toBe(true);
      expect(created.error).toBeUndefined();

      await runZinn(["task", "create", "APP", "--title", "Kept", "--priority=high", "--json"], store);
      expect(lastRecord(store)).toMatchObject({
        command: { route: "task create", help: false },
        options: [
          { name: "--title", valueForm: "next" },
          { name: "--priority", valueForm: "joined" },
          { name: "--json", valueForm: "none" },
        ],
        positionals: 1,
      });

      await runZinn(["task", "list", "APP"], store);
      expect(lastRecord(store)).toMatchObject({ exitCode: 0, command: { route: "task list" } });
    });
  });

  test("an alias names the canonical route and the words typed", async () => {
    await withIsolatedZinnDir(async (store) => {
      await createProject(store);
      await runZinn(["project", "ls"], store);

      expect(lastRecord(store).command).toEqual({ route: "project list", alias: "project ls", help: false });
    });
  });

  test("an agent's identity comes from the environment and matches activity's fields", async () => {
    await withIsolatedZinnDir(async (store) => {
      const env = {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "session-1",
        ZINN_AGENT: "reviewer",
        ZINN_MODEL: "model-1",
        ZINN_EFFORT: "high",
        ZINN_CLIENT: "host/2",
      };
      expect((await runZinn(["project", "create", "APP"], store, env)).code).toBe(0);

      expect(lastRecord(store).actor).toEqual({
        kind: "agent",
        name: "claude-code",
        source: "env:CLAUDECODE",
        sessionId: "session-1",
        agent: "reviewer",
        model: "model-1",
        effort: "high",
        client: `zinn-cli/${packageJson.version} host/2`,
      });
    });
  });

  test("an invalid flag names the option and has no positional count", async () => {
    await withIsolatedZinnDir(async (store) => {
      await createProject(store);
      const result = await runZinn(["project", "list", "--bad", "--worse=value"], store);

      expect(result.code).toBe(1);
      const record = lastRecord(store);
      expect(record).toMatchObject({
        exitCode: 1,
        command: { route: "project list", help: false },
        error: { code: "invalid_input", reason: "unknown_option", argument: "--bad" },
      });
      expect(record.options).toEqual([{ name: "--bad" }, { name: "--worse", valueForm: "joined" }]);
      expect(record.positionals).toBeUndefined();
      expect(record.error.logFileName).toBeUndefined();
    });
  });

  test("a string option with nothing after it has no value form", async () => {
    await withIsolatedZinnDir(async (store) => {
      await runZinn(["task", "create", "APP", "--title"], store);

      expect(lastRecord(store).options).toEqual([{ name: "--title" }]);
      expect(lastRecord(store).positionals).toBeUndefined();
    });
  });

  test("a refusal after parsing keeps the positional count, including words after --", async () => {
    await withIsolatedZinnDir(async (store) => {
      await createProject(store);
      await runZinn(["project", "list", "extra"], store);
      expect(lastRecord(store)).toMatchObject({
        positionals: 1,
        error: { code: "invalid_input", reason: "unexpected_argument" },
      });

      await runZinn(["project", "list", "--", "--one", "two"], store);
      expect(lastRecord(store).positionals).toBe(2);
      expect(lastRecord(store).options).toEqual([]);
    });
  });

  test("an unknown command records its nearest namespace and first unmatched word", async () => {
    await withIsolatedZinnDir(async (store) => {
      await runZinn(["task", "frobnicate", "more"], store);
      const nested = lastRecord(store);
      expect(nested.command).toEqual({ namespace: "task", unmatchedWord: "frobnicate", help: false });
      expect(nested.positionals).toBeUndefined();
      expect(nested.error).toEqual({
        code: "invalid_input",
        reason: "unknown_command",
        argument: "command",
        suggestedRoute: "task",
      });

      await runZinn(["frobnicate"], store);
      expect(lastRecord(store).command).toEqual({ namespace: "", unmatchedWord: "frobnicate", help: false });
    });
  });

  test("bare zinn, root help and namespace help are recorded with what was written", async () => {
    await withIsolatedZinnDir(async (store) => {
      await runZinn([], store);
      expect(lastRecord(store)).toMatchObject({ exitCode: 0, command: { namespace: "", help: false }, options: [] });
      expect(lastRecord(store).positionals).toBeUndefined();

      await runZinn(["--help"], store);
      expect(lastRecord(store)).toMatchObject({
        command: { namespace: "", help: true },
        options: [{ name: "--help", valueForm: "none" }],
      });

      await runZinn(["task", "-h", "--json"], store);
      expect(lastRecord(store)).toMatchObject({
        command: { namespace: "task", help: true },
        options: [{ name: "-h", valueForm: "none" }, { name: "--json", valueForm: "none" }],
      });
    });
  });

  test("command help is recorded without a positional count", async () => {
    await withIsolatedZinnDir(async (store) => {
      await runZinn(["task", "show", "APP-1", "--help"], store);

      expect(lastRecord(store)).toMatchObject({
        exitCode: 0,
        command: { route: "task view", alias: "task show", help: true },
      });
      expect(lastRecord(store).positionals).toBeUndefined();
    });
  });

  test("a failure before the database opens is recorded", async () => {
    await withIsolatedZinnDir(async (store) => {
      const result = await runZinn(["project", "list"], store);

      expect(result.code).toBe(1);
      expect(lastRecord(store)).toMatchObject({
        command: { route: "project list" },
        positionals: 0,
        error: { code: "not_found", suggestedRoute: "project create" },
      });
    });
  });
});

describe("telemetry and the failure log", () => {
  test("a storage failure names the log it wrote, by file name only", async () => {
    await withIsolatedZinnDir(async (store) => {
      corruptDatabase(store);
      const result = await runZinn(["project", "list"], store);

      expect(result.code).toBe(1);
      const [logName, ...others] = readdirSync(join(store, "logs"));
      expect(others).toEqual([]);
      expect(lastRecord(store).error).toMatchObject({ code: "storage", logFileName: logName });
    });
  });

  test("an invalid_input failure has no log file name", async () => {
    await withIsolatedZinnDir(async (store) => {
      await runZinn(["frobnicate"], store);

      expect(existsSync(join(store, "logs"))).toBe(false);
      expect(Object.keys(lastRecord(store).error)).not.toContain("logFileName");
    });
  });

  test("an unwritable logs folder leaves the field out and the record written", async () => {
    await withIsolatedZinnDir(async (store) => {
      corruptDatabase(store);
      writeFileSync(join(store, "logs"), "");
      const result = await runZinn(["project", "list"], store);

      expect(result.code).toBe(1);
      expect(lastRecord(store).error.code).toBe("storage");
      expect(Object.keys(lastRecord(store).error)).not.toContain("logFileName");
    });
  });
});

describe("runs that write no record", () => {
  test("--version, -v and successful whoami, capabilities and info leave an existing store alone", async () => {
    await withIsolatedZinnDir(async (store) => {
      for (const args of [["--version"], ["-v"], ["whoami"], ["capabilities"], ["info"], ["info", "--json"]]) {
        expect((await runZinn(args, store)).code, args.join(" ")).toBe(0);
        expect(readdirSync(store), args.join(" ")).toEqual([]);
      }
    });
  });

  test("whoami, capabilities and info are recorded when they fail or print help", async () => {
    await withIsolatedZinnDir(async (store) => {
      for (const route of ["whoami", "capabilities", "info"]) {
        const before = readRecords(store).length;
        const failed = await runZinn([route, "extra"], store);
        expect(failed.code, route).toBe(1);
        expect(expectOneMore(store, before)).toMatchObject({ exitCode: 1, command: { route, help: false } });

        expect((await runZinn([route, "--help"], store)).code, route).toBe(0);
        expect(expectOneMore(store, before + 1)).toMatchObject({ exitCode: 0, command: { route, help: true } });
      }
    });
  });

  test("a successful whoami reads no settings, so an unusable file changes nothing", async () => {
    await withIsolatedZinnDir(async (store) => {
      writeFileSync(join(store, "settings.json"), "{ not json");
      const result = await runZinn(["whoami"], store, { ZINN_DEBUG: "1" });

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("::telemetry");
    });
  });

  test("a sole version flag is the only version path that skips the router", async () => {
    await withIsolatedZinnDir(async (store) => {
      expect((await runZinn(["--version", "extra"], store)).code).toBe(1);
      expect(lastRecord(store).command).toEqual({ namespace: "", unmatchedWord: undefined, help: false });
      expect(lastRecord(store).options).toEqual([{ name: "--version" }]);
    });
  });

  test("a fresh home leaves no directory", async () => {
    await withIsolatedZinnDir(async (root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: home };
      delete env.ZINN_DIR;

      for (const args of [["--help"], ["frobnicate"], ["task", "list"]]) {
        await runProcessAsync([process.execPath, CLI_PATH, ...args], { env, cwd: home });
        expect(existsSync(join(home, ".zinn")), args.join(" ")).toBe(false);
      }
    });
  });

  test("mode off and DO_NOT_TRACK write nothing, and a failure log is still written", async () => {
    await withIsolatedZinnDir(async (store) => {
      corruptDatabase(store);
      expect((await runZinn(["project", "list"], store, { DO_NOT_TRACK: "1" })).code).toBe(1);
      expect(existsSync(telemetryFolder(store))).toBe(false);
      expect(readdirSync(join(store, "logs"))).toHaveLength(1);

      writeFileSync(join(store, "settings.json"), JSON.stringify({ telemetry: { mode: "off" } }));
      expect((await runZinn(["project", "list"], store)).code).toBe(1);
      expect(existsSync(telemetryFolder(store))).toBe(false);
      expect(readdirSync(join(store, "logs"))).toHaveLength(2);
    });
  });
});

describe("telemetry failures", () => {
  for (const args of [["project", "list"], ["label", "list", "--json"], ["task", "view", "APP-99", "--json"], ["frobnicate"], ["--help"]]) {
    test(`an unwritable telemetry path leaves zinn ${args.join(" ")} unchanged and ZINN_DEBUG names it`, async () => {
      await withIsolatedZinnDir(async (store) => {
        await withIsolatedZinnDir(async (control) => {
          await createProject(store);
          await createProject(control);
          const folder = telemetryFolder(store);
          // A file where the folder belongs refuses the write for any user, including root.
          renameSync(folder, join(store, "moved"));
          writeFileSync(folder, "");

          const expected = await runZinn(args, control);
          const result = await runZinn(args, store);
          expectSameResult(result, expected);

          const debugged = await runZinn(args, store, { ZINN_DEBUG: "1" });
          expect(debugged.code).toBe(expected.code);
          expect(debugged.stdout).toBe(expected.stdout);
          const isJsonFailure = args.includes("--json") && expected.code === 1;
          if (isJsonFailure) {
            expect(JSON.parse(debugged.stderr).error.diagnostics.join("\n")).toContain("::telemetry");
          } else {
            const lines = debugged.stderr.split("\n").filter((line) => line.startsWith("::telemetry"));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain(folder);
          }
        });
      });
    });
  }

  test("an unusable settings file writes no record and leaves the refusal unchanged", async () => {
    await withIsolatedZinnDir(async (store) => {
      writeFileSync(join(store, "settings.json"), "{ not json");
      const result = await runZinn(["project", "list", "--json"], store);

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      expect(existsSync(telemetryFolder(store))).toBe(false);

      const debugged = await runZinn(["project", "list"], store, { ZINN_DEBUG: "1" });
      expect(debugged.stderr.split("\n").filter((line) => line.startsWith("::telemetry"))).toHaveLength(1);
    });
  });

  test("a missing Zinn directory is not created", async () => {
    await withIsolatedZinnDir(async (root) => {
      const missing = join(root, "missing");
      const env = { ...TEST_ENVIRONMENT, ZINN_DIR: missing };
      const result = await runProcessAsync([process.execPath, CLI_PATH, "project", "list"], { env, cwd: root });

      expect(result.code).toBe(1);
      expect(existsSync(missing)).toBe(false);
    });
  });
});

/** A record file name for the UTC date this many days before today */
function recordFileName(daysAgo: number, sequence = 1) {
  const date = new Date(Date.now() - daysAgo * MILLISECONDS_PER_DAY);
  return `${date.toISOString().slice(0, 10)}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/** Creates a record file of this many bytes, sparse so a large one stays fast */
function prepareRecordFile(store: string, name: string, bytes = 0) {
  mkdirSync(telemetryFolder(store), { recursive: true });
  writeFileSync(join(telemetryFolder(store), name), "");
  truncateSync(join(telemetryFolder(store), name), bytes);
  return name;
}

function setTelemetry(store: string, telemetry: object) {
  writeFileSync(join(store, "settings.json"), JSON.stringify({ telemetry }));
}

function listTelemetry(store: string) {
  return readdirSync(telemetryFolder(store)).sort();
}

/** The records in one file. For a store whose other files are sparse, which hold no records */
function readFileRecords(store: string, name: string): Array<any> {
  const text = readFileSync(join(telemetryFolder(store), name), "utf8");
  return text.replaceAll("\0", "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function telemetryLines(run: Run) {
  return run.stderr.split("\n").filter((line) => line.startsWith("::telemetry"));
}

/** Runs zinn with the telemetry folder at this mode, and restores the mode for the checks after */
async function runWithFolderMode(
  store: string,
  mode: number,
  args: Array<string>,
  env: Record<string, string> = {},
) {
  chmodSync(telemetryFolder(store), mode);
  try {
    return await runZinn(args, store, env);
  } finally {
    chmodSync(telemetryFolder(store), 0o700);
  }
}

describe("telemetry retention", () => {
  const rotationBytes = Math.floor(BYTES_PER_MEGABYTE / 10);

  test("a new file deletes files older than 90 days and keeps one exactly 90 days old", async () => {
    await withIsolatedZinnDir(async (store) => {
      prepareRecordFile(store, recordFileName(400));
      prepareRecordFile(store, recordFileName(91));
      const exactly90 = prepareRecordFile(store, recordFileName(90));
      const recent = prepareRecordFile(store, recordFileName(1));

      expect((await runZinn(["--help"], store)).code).toBe(0);

      expect(listTelemetry(store)).toEqual([exactly90, recent, recordFileName(0)].sort());
      expect(readRecords(store)).toHaveLength(1);
    });
  });

  test("telemetry.maxAgeDays sets how long files are kept", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxAgeDays: 365 });
      prepareRecordFile(store, recordFileName(366));
      const kept = prepareRecordFile(store, recordFileName(200));

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([kept, recordFileName(0)].sort());
    });
  });

  test("a telemetry.maxAgeDays too large for a date keeps old files and cleans up without a failure", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxAgeDays: Number.MAX_SAFE_INTEGER });
      const old = prepareRecordFile(store, "2001-01-01-0001.jsonl");

      const result = await runZinn(["--help"], store, { ZINN_DEBUG: "1" });

      expect(telemetryLines(result)).toEqual([]);
      expect(listTelemetry(store)).toEqual([old, recordFileName(0)].sort());
    });
  });

  test("a name's digits are matched without checking the calendar", async () => {
    await withIsolatedZinnDir(async (store) => {
      prepareRecordFile(store, "2000-99-99-0001.jsonl");

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([recordFileName(0)]);
    });
  });

  test("a small cap deletes oldest first until the total is under it, including a total exactly at it", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      const half = BYTES_PER_MEGABYTE / 2;
      prepareRecordFile(store, recordFileName(5), half);
      prepareRecordFile(store, recordFileName(4), half);
      const newest = prepareRecordFile(store, recordFileName(3), half);

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([newest, recordFileName(0)].sort());
    });
  });

  test("a total just under the cap deletes nothing", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      const half = BYTES_PER_MEGABYTE / 2;
      const older = prepareRecordFile(store, recordFileName(5), half);
      const newer = prepareRecordFile(store, recordFileName(4), half - 1);

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([older, newer, recordFileName(0)].sort());
    });
  });

  test("a current file below a tenth of the cap appends and deletes nothing, even with expired files", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      const expired = prepareRecordFile(store, recordFileName(200));
      const today = prepareRecordFile(store, recordFileName(0), rotationBytes - 1);

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([expired, today].sort());
      expect(statSync(join(telemetryFolder(store), today)).size).toBeGreaterThan(rotationBytes - 1);
    });
  });

  test("a current file at a tenth of the cap starts the next file and keeps the record", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      prepareRecordFile(store, recordFileName(200));
      const full = prepareRecordFile(store, recordFileName(0), rotationBytes);

      const result = await runZinn(["--help"], store, { ZINN_DEBUG: "1" });

      expect(result.code).toBe(0);
      expect(telemetryLines(result)).toEqual([]);
      expect(listTelemetry(store)).toEqual([full, recordFileName(0, 2)]);
      expect(statSync(join(telemetryFolder(store), full)).size).toBe(rotationBytes);
      expect(readFileRecords(store, recordFileName(0, 2))).toHaveLength(1);
    });
  });

  test("a sequence continues from the highest of today's files", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      const first = prepareRecordFile(store, recordFileName(0, 1), rotationBytes);
      const tenth = prepareRecordFile(store, recordFileName(0, 10), rotationBytes - 1);

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([first, tenth]);
      expect(readFileRecords(store, tenth)).toHaveLength(1);
    });
  });

  test("a cap filled by one day removes only as much older history as it needs", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      prepareRecordFile(store, recordFileName(3), 100);
      const yesterday = prepareRecordFile(store, recordFileName(1), 1);
      const today = Array.from({ length: 10 }, (_, index) =>
        prepareRecordFile(store, recordFileName(0, index + 1), rotationBytes),
      );

      expect((await runZinn(["--help"], store)).code).toBe(0);

      // The ten full files stay just under the cap, so the older files take it over and the oldest goes first
      expect(listTelemetry(store)).toEqual([yesterday, ...today, recordFileName(0, 11)].sort());
      expect(readFileRecords(store, recordFileName(0, 11))).toHaveLength(1);
    });
  });

  test("other files and a folder with a record-file name stay and do not count", async () => {
    await withIsolatedZinnDir(async (store) => {
      setTelemetry(store, { maxMegabytes: 1 });
      const folder = telemetryFolder(store);
      const others = ["notes.txt", "2000-01-01.jsonl", "2000-01-01-0001.jsonl.bak", "2000-1-1-0001.jsonl"];
      for (const name of others) {
        prepareRecordFile(store, name, 2 * BYTES_PER_MEGABYTE);
      }
      const namedFolder = "2000-01-02-0001.jsonl";
      mkdirSync(join(folder, namedFolder));
      const recent = prepareRecordFile(store, recordFileName(1), BYTES_PER_MEGABYTE / 2);

      await runZinn(["--help"], store);

      expect(listTelemetry(store)).toEqual([...others, namedFolder, recent, recordFileName(0)].sort());
    });
  });

  test("runs that write no record delete nothing", async () => {
    const cases: Array<{ args: Array<string>; env?: Record<string, string>; settings: object }> = [
      { args: ["--help"], settings: { telemetry: { mode: "off", maxMegabytes: 1 } } },
      { args: ["--help"], env: { DO_NOT_TRACK: "1" }, settings: { telemetry: { maxMegabytes: 1 } } },
      { args: ["--version"], settings: { telemetry: { maxMegabytes: 1 } } },
      { args: ["whoami"], settings: { telemetry: { maxMegabytes: 1 } } },
    ];

    for (const { args, env, settings } of cases) {
      await withIsolatedZinnDir(async (store) => {
        writeFileSync(join(store, "settings.json"), JSON.stringify(settings));
        prepareRecordFile(store, recordFileName(200));
        prepareRecordFile(store, recordFileName(1), 2 * BYTES_PER_MEGABYTE);
        const before = listTelemetry(store);

        expect((await runZinn(args, store, env)).code, args.join(" ")).toBe(0);

        expect(listTelemetry(store), args.join(" ")).toEqual(before);
      });
    }
  });

  test.skipIf(!doFolderModesBind)("a cleanup that cannot list keeps the result and the record, and says so", async () => {
    const args = ["frobnicate"];

    await withIsolatedZinnDir(async (control) => {
      const expected = await runZinn(args, control);

      await withIsolatedZinnDir(async (store) => {
        prepareRecordFile(store, recordFileName(200));
        expectSameResult(await runWithFolderMode(store, 0o300, args), expected);
      });

      await withIsolatedZinnDir(async (store) => {
        const expired = prepareRecordFile(store, recordFileName(200));
        const debugged = await runWithFolderMode(store, 0o300, args, { ZINN_DEBUG: "1" });

        expect(debugged.code).toBe(expected.code);
        expect(debugged.stdout).toBe(expected.stdout);
        const lines = telemetryLines(debugged);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(telemetryFolder(store));
        expect(lines[0]).not.toContain("could not write");
        expect(listTelemetry(store)).toEqual([expired, recordFileName(0)].sort());
        expect(readRecords(store)).toHaveLength(1);
      });
    });
  });

  test.skipIf(!doFolderModesBind)("a cleanup that cannot delete in a folder that refuses the append names the append failure", async () => {
    const args = ["frobnicate"];

    await withIsolatedZinnDir(async (control) => {
      const expected = await runZinn(args, control);

      await withIsolatedZinnDir(async (store) => {
        prepareRecordFile(store, recordFileName(200));
        expectSameResult(await runWithFolderMode(store, 0o555, args), expected);
      });

      await withIsolatedZinnDir(async (store) => {
        const expired = prepareRecordFile(store, recordFileName(200));
        const debugged = await runWithFolderMode(store, 0o555, args, { ZINN_DEBUG: "1" });

        expect(debugged.code).toBe(expected.code);
        expect(debugged.stdout).toBe(expected.stdout);
        const lines = telemetryLines(debugged);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(join(telemetryFolder(store), recordFileName(0)));
        expect(listTelemetry(store)).toEqual([expired]);
      });
    });
  });

  test("parallel runs starting a new file exit normally and leave only whole lines", async () => {
    await withIsolatedZinnDir(async (store) => {
      for (let daysAgo = 100; daysAgo < 140; daysAgo += 1) {
        prepareRecordFile(store, recordFileName(daysAgo));
      }
      const runs = 30;

      const results = await Promise.all(
        Array.from({ length: runs }, () => runZinn(["--help"], store, { ZINN_DEBUG: "1" })),
      );

      for (const result of results) {
        expect(result.code).toBe(0);
        expect(telemetryLines(result)).toEqual([]);
      }
      expect(listTelemetry(store)).toEqual([recordFileName(0)]);
      expect(readRecords(store)).toHaveLength(runs);
    });
  });
});

describe("telemetry contents", () => {
  test("parallel runs leave only whole lines", async () => {
    await withIsolatedZinnDir(async (store) => {
      const runs = 30;
      await Promise.all(Array.from({ length: runs }, () => runZinn(["--help"], store)));

      expect(readRecords(store)).toHaveLength(runs);
    });
  });

  test("a record holds none of the values and positionals a run passes", async () => {
    await withIsolatedZinnDir(async (store) => {
      await createProject(store);
      const secretWord = "secretword";
      const cases = [
        ["task", "create", "APP", "--title", SECRET_TITLE, "--json"],
        ["task", "create", "APP", `--title=${SECRET_TITLE}`],
        ["task", "search", "--", SECRET_TITLE],
        ["task", "view", SECRET_KEY],
        ["task", "edit", SECRET_KEY, "--title", SECRET_TITLE, "--bad", SECRET_TITLE],
        ["task", "search", `-${SECRET_TITLE}`],
        ["frobnicate", SECRET_TITLE, `--title=${SECRET_TITLE}`],
        [`--title=${SECRET_TITLE}`, secretWord],
        ["--title", SECRET_TITLE],
        ["task", `--title=${SECRET_TITLE}`],
        ["frobnicate", "--", SECRET_TITLE],
      ];

      for (const args of cases) {
        await runZinn(args, store);
      }

      const text = readdirSync(telemetryFolder(store))
        .map((name) => readFileSync(join(telemetryFolder(store), name), "utf8"))
        .join("");
      expect(text.split("\n").filter(Boolean)).toHaveLength(cases.length + 1);
      for (const fragment of [SECRET_TITLE, SECRET_KEY, secretWord, store]) {
        expect(text).not.toContain(fragment);
      }
    });
  });
});
