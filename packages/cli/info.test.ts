import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { runCli } from "./testing.ts";
import cliPackage from "./package.json";
import corePackage from "../core/package.json";
import { latestVersion, MIGRATIONS } from "../core/src/migrations/registry.ts";
import type { PresentedInfo } from "./src/result-schemas.ts";
import { presentInfo } from "./src/presentation/info-presentation.ts";

let root: string;
let home: string;
let cwd: string;
const currentVersion = latestVersion(MIGRATIONS);
const runtime = process.env.ZINN_INFO_TEST_RUNTIME;
const cliPath = process.env.ZINN_INFO_TEST_CLI;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zinn-cli-info-")));
  home = join(root, "home");
  cwd = join(root, "repo", "nested");
  mkdirSync(home);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "repo", ".git"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: Array<string>, directory?: string, extraEnv: Record<string, string | undefined> = {}) {
  return runCli(args, {
    runtime,
    cliPath,
    cwd,
    env: { ...TEST_ENVIRONMENT, HOME: home, NODE_ENV: "test", ZINN_DIR: directory, ZINN_DEBUG: undefined, DEBUG: undefined, DO_NOT_TRACK: undefined, FORCE_COLOR: "0", ...extraEnv },
  });
}

function settings(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

async function report(directory?: string): Promise<PresentedInfo> {
  const result = await run(["info", "--json"], directory);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("ZINN-133: text and JSON report paths and versions without creating the default store", async () => {
  const found = await report();
  expect(found.storage).toMatchObject({ directory: join(home, ".zinn"), source: "default", exists: false });
  expect(found.database).toMatchObject({ state: "absent", latestVersion: currentVersion });
  expect(found.versions).toMatchObject({ cli: cliPackage.version, core: corePackage.version });
  expect(found.versions.runtime.name).toBe(runtime === undefined ? "Bun" : "Node");
  expect(found.versions.runtime.version).toBeString();
  const text = await run(["info"]);
  expect(text.code).toBe(0);
  expect(text.stderr).toBe("");
  for (const fact of [found.storage.directory!, found.database.path!, cliPackage.version, corePackage.version, found.versions.runtime.name]) {
    expect(text.stdout).toContain(fact);
  }
  expect(existsSync(join(home, ".zinn"))).toBe(false);
  expect(readdirSync(join(root, "repo"), { recursive: true }).sort()).toEqual([".git", "nested"]);
  const version = await run(["--version"]);
  expect(version.stdout.trim()).toBe(cliPackage.version);
});

test("the info presenter selects public fields from an extended core report", async () => {
  const expected = await report();
  const { versions, ...fields } = expected;
  const coreReport = { ...fields, coreVersion: versions.core, extraCoreField: true };
  expect(presentInfo(coreReport)).toEqual(expected);
});

test("local settings and inherited default project are reported from a repository subfolder", async () => {
  const globalPath = join(home, ".zinn", "settings.json");
  const localPath = join(root, "repo", "zinn.local.json");
  settings(globalPath, { defaultProject: "GLOBAL" });
  settings(localPath, { storage: { directory: "store" } });
  const found = await report();
  expect(found.storage).toMatchObject({ directory: join(root, "repo", "store"), source: "local", settingsPath: localPath });
  expect(found.defaultProject).toEqual({ key: "GLOBAL", settingsPath: globalPath, error: null });
  expect(found.settingsFiles.map((file) => file.path)).toEqual([globalPath, join(cwd, "zinn.local.json"), localPath]);
  expect(existsSync(join(root, "repo", "store"))).toBe(false);
});

test("ZINN_DIR ignores unusable home and local files and does not create an explicitly missing store", async () => {
  settings(join(home, ".zinn", "settings.json"), "{");
  settings(join(cwd, "zinn.local.json"), "{");
  const missing = join(root, "missing");
  const found = await report(missing);
  expect(found.storage).toMatchObject({ directory: missing, source: "env", exists: false, error: null });
  expect(found.settingsFiles.map((file) => file.state)).toEqual(["missing", "not-read", "not-read"]);
  expect(existsSync(missing)).toBe(false);
  const selected = join(root, "selected");
  settings(join(selected, "settings.json"), { defaultProject: "SELECTED" });
  expect((await report(selected)).defaultProject).toMatchObject({ key: "SELECTED", settingsPath: join(selected, "settings.json"), error: null });
});

test("broken settings leave values unavailable while info succeeds and ordinary commands still fail", async () => {
  settings(join(home, ".zinn", "settings.json"), { defaultProject: "GLOBAL" });
  const path = join(cwd, "zinn.local.json");
  settings(path, "{");
  const found = await report();
  expect(found.storage.directory).toBeNull();
  expect(found.defaultProject.key).toBeNull();
  expect(found.defaultProject.error).toContain(path);
  expect(found.settingsFiles.at(-1)).toMatchObject({ path, state: "error" });
  const ordinary = await run(["project", "list", "--json"]);
  expect(ordinary.code).toBe(1);
  expect(ordinary.stdout).toBe("");
  expect(JSON.parse(ordinary.stderr).error.message).toContain(path);
  expect(existsSync(join(home, ".zinn", "data"))).toBe(false);
});

test("an unusable settings file's error prints once in the text output while JSON keeps it on every field", async () => {
  const path = join(cwd, "zinn.local.json");
  settings(path, { defaultProject: 42, storage: { directory: 5 } });
  const found = await report();
  const file = found.settingsFiles.find((candidate) => candidate.path === path);
  if (file?.state !== "error") {
    throw new Error("expected the local settings file to be reported as an error");
  }
  expect(found.storage.error).toBe(file.error);
  expect(found.database.error).toBe(file.error);
  expect(found.defaultProject.error).toBe(file.error);

  const text = await run(["info"]);
  expect(text.code).toBe(0);
  expect(text.stderr).toBe("");
  expect(text.stdout.split(file.error)).toHaveLength(2);
  expect(text.stdout).toContain(path);
});

test("corrupt and non-SQLite files produce database errors while preserving the rest of the report", async () => {
  for (const kind of ["corrupt", "not-sqlite"]) {
    const directory = join(root, kind);
    mkdirSync(join(directory, "data"), { recursive: true });
    const path = join(directory, "data", "zinn.sqlite");
    if (kind === "corrupt") {
      const db = new Database(path);
      db.exec("CREATE TABLE sample(value TEXT)");
      db.close();
      const bytes = readFileSync(path);
      bytes[100] = 255;
      writeFileSync(path, bytes);
    } else {
      writeFileSync(path, "not a SQLite database");
    }
    const found = await report(directory);
    expect(found.database).toMatchObject({ path, state: "unavailable", version: null });
    expect(found.database.error).toBeString();
    expect(found.storage.directory).toBe(directory);
    expect(found.versions.core).toBe(corePackage.version);
    const text = await run(["info"], directory);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(path);
    expect(text.stdout).toContain(found.database.error!);
  }
});

test("inspection preserves real task data, activity and schema", async () => {
  const directory = join(root, "store");
  mkdirSync(directory);
  expect((await run(["project", "create", "INFO", "--json"], directory)).code).toBe(0);
  expect((await run(["task", "create", "INFO", "--title", "Keep this task", "--json"], directory)).code).toBe(0);
  const snapshot = () => {
    const db = new Database(join(directory, "data", "zinn.sqlite"));
    try {
      return {
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
        schema: db.query("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
        version: db.query("PRAGMA user_version").get(),
      };
    } finally {
      db.close();
    }
  };
  const before = snapshot();
  expect((await report(directory)).database).toMatchObject({ state: "current", version: currentVersion });
  expect(snapshot()).toEqual(before);
});

test("info classifies unmarked, older and newer files without initializing or upgrading them", async () => {
  for (const [version, state] of [[0, "unmarked"], [currentVersion - 1, "older"], [currentVersion + 1, "newer"]] as const) {
    const directory = join(root, state);
    mkdirSync(join(directory, "data"), { recursive: true });
    const path = join(directory, "data", "zinn.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    expect((await report(directory)).database).toMatchObject({ state, version, latestVersion: currentVersion, error: null });
    const checked = new Database(path);
    expect(checked.query("SELECT name FROM sqlite_schema").all()).toEqual([{ name: "sample" }]);
    expect(checked.query("SELECT value FROM sample").all()).toEqual([{ value: "preserved" }]);
    expect(checked.query("PRAGMA user_version").get()).toEqual({ user_version: version });
    checked.close();
  }
});

test("info sees a committed schema version in WAL while another connection remains open", async () => {
  const directory = join(root, "wal-store");
  mkdirSync(join(directory, "data"), { recursive: true });
  const db = new Database(join(directory, "data", "zinn.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
    db.exec(`PRAGMA user_version=${currentVersion - 1}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA user_version=${currentVersion}`);
    expect((await report(directory)).database).toMatchObject({ state: "current", version: currentVersion, error: null });
    expect(db.query("SELECT * FROM sample").all()).toEqual([{ value: "preserved" }]);
  } finally {
    db.close();
  }
});

test("info rejects unexpected arguments and flags through the normal CLI error path", async () => {
  for (const args of [["info", "extra", "--json"], ["info", "--unknown", "--json"]]) {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toBeObject();
  }
});

// ? ZINN-347
test("ZINN-347: telemetry state is reported in JSON and text from settings and DO_NOT_TRACK", async () => {
  const directory = join(root, "store");
  mkdirSync(join(directory, "telemetry"), { recursive: true });
  writeFileSync(join(directory, "telemetry", "2026-11-06.jsonl"), "x".repeat(10));
  const fallback = await report(directory);
  expect(fallback.telemetry).toEqual({ mode: "local", source: "default", settingsPath: null, maxMegabytes: 1024, directory: join(directory, "telemetry"), exists: true, sizeBytes: 10, error: null });

  const tracked = await run(["info", "--json"], directory, { DO_NOT_TRACK: "1" });
  expect(JSON.parse(tracked.stdout).telemetry).toMatchObject({ mode: "off", source: "DO_NOT_TRACK", settingsPath: null });
  const ignored = await run(["info", "--json"], directory, { DO_NOT_TRACK: "true" });
  expect(JSON.parse(ignored.stdout).telemetry).toMatchObject({ mode: "local", source: "default" });

  const path = join(directory, "settings.json");
  settings(path, { telemetry: { mode: "local", maxMegabytes: 2 } });
  const overridden = await run(["info", "--json"], directory, { DO_NOT_TRACK: "1" });
  expect(JSON.parse(overridden.stdout).telemetry).toMatchObject({ mode: "local", source: "settings", settingsPath: path, maxMegabytes: 2 });
  const text = await run(["info"], directory, { DO_NOT_TRACK: "1" });
  expect(text.code).toBe(0);
  expect(text.stderr).toBe("");
  for (const fact of ["local", path, "2", join(directory, "telemetry"), "10"]) {
    expect(text.stdout).toContain(fact);
  }
});

test("ZINN-347: a rejected telemetry cap leaves info working and ordinary commands refused with the file named", async () => {
  const directory = join(root, "store");
  const path = join(directory, "settings.json");
  for (const maxMegabytes of ["1G", 0, 1.5]) {
    settings(path, { telemetry: { maxMegabytes } });
    const found = await report(directory);
    expect(found.telemetry).toMatchObject({ mode: null, maxMegabytes: null });
    expect(found.telemetry.error).toContain(path);
    const ordinary = await run(["project", "list", "--json"], directory);
    expect(ordinary.code).toBe(1);
    expect(JSON.parse(ordinary.stderr).error.message).toContain(path);
  }
});

test("ZINN-347: info never creates the telemetry folder", async () => {
  const directory = join(root, "store");
  mkdirSync(directory);
  await report(directory);
  await run(["info"], directory);
  expect(readdirSync(directory)).toEqual([]);
});
