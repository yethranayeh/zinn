import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { runCli } from "./testing.ts";
import cliPackage from "./package.json";
import corePackage from "../core/package.json";
import { latestVersion, MIGRATIONS } from "../core/src/migrations/registry.ts";
import type { PresentedInfo } from "./src/presentation/info-presentation.ts";

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

function run(args: Array<string>, directory?: string) {
  return runCli(args, {
    runtime,
    cliPath,
    cwd,
    env: { ...process.env, HOME: home, NODE_ENV: "test", ZINN_DIR: directory, ZINN_DEBUG: undefined, DEBUG: undefined, FORCE_COLOR: "0" },
  });
}

function settings(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function report(directory?: string): PresentedInfo {
  const result = run(["info", "--json"], directory);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("ZINN-133: text and JSON report paths and versions without creating the default store", () => {
  const found = report();
  expect(found.storage).toMatchObject({ directory: join(home, ".zinn"), source: "default", exists: false });
  expect(found.database).toMatchObject({ state: "absent", latestVersion: currentVersion });
  expect(found.versions).toMatchObject({ cli: cliPackage.version, core: corePackage.version });
  expect(found.versions.runtime.name).toBe(runtime === undefined ? "Bun" : "Node");
  expect(found.versions.runtime.version).toBeString();
  const text = run(["info"]);
  expect(text.code).toBe(0);
  expect(text.stderr).toBe("");
  for (const fact of [found.storage.directory!, found.database.path!, cliPackage.version, corePackage.version, found.versions.runtime.name]) {
    expect(text.stdout).toContain(fact);
  }
  expect(existsSync(join(home, ".zinn"))).toBe(false);
  expect(readdirSync(join(root, "repo"), { recursive: true })).toEqual([".git", "nested"]);
  const version = run(["--version"]);
  expect(version.stdout.trim()).toBe(cliPackage.version);
});

test("local settings and inherited default project are reported from a repository subfolder", () => {
  const globalPath = join(home, ".zinn", "settings.json");
  const localPath = join(root, "repo", "zinn.local.json");
  settings(globalPath, { defaultProject: "GLOBAL" });
  settings(localPath, { storage: { directory: "store" } });
  const found = report();
  expect(found.storage).toMatchObject({ directory: join(root, "repo", "store"), source: "local", settingsPath: localPath });
  expect(found.defaultProject).toEqual({ key: "GLOBAL", settingsPath: globalPath, error: null });
  expect(found.settingsFiles.map((file) => file.path)).toEqual([globalPath, join(cwd, "zinn.local.json"), localPath]);
  expect(existsSync(join(root, "repo", "store"))).toBe(false);
});

test("ZINN_DIR ignores unusable home and local files and does not create an explicitly missing store", () => {
  settings(join(home, ".zinn", "settings.json"), "{");
  settings(join(cwd, "zinn.local.json"), "{");
  const missing = join(root, "missing");
  const found = report(missing);
  expect(found.storage).toMatchObject({ directory: missing, source: "env", exists: false, error: null });
  expect(found.settingsFiles.map((file) => file.state)).toEqual(["missing", "not-read", "not-read"]);
  expect(existsSync(missing)).toBe(false);
  const selected = join(root, "selected");
  settings(join(selected, "settings.json"), { defaultProject: "SELECTED" });
  expect(report(selected).defaultProject).toMatchObject({ key: "SELECTED", settingsPath: join(selected, "settings.json"), error: null });
});

test("broken settings leave values unavailable while info succeeds and ordinary commands still fail", () => {
  settings(join(home, ".zinn", "settings.json"), { defaultProject: "GLOBAL" });
  const path = join(cwd, "zinn.local.json");
  settings(path, "{");
  const found = report();
  expect(found.storage.directory).toBeNull();
  expect(found.defaultProject.key).toBeNull();
  expect(found.defaultProject.error).toContain(path);
  expect(found.settingsFiles.at(-1)).toMatchObject({ path, state: "error" });
  const ordinary = run(["project", "list", "--json"]);
  expect(ordinary.code).toBe(1);
  expect(ordinary.stdout).toBe("");
  expect(JSON.parse(ordinary.stderr).error.message).toContain(path);
  expect(existsSync(join(home, ".zinn", "data"))).toBe(false);
});

test("corrupt and non-SQLite files produce database errors while preserving the rest of the report", () => {
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
    const found = report(directory);
    expect(found.database).toMatchObject({ path, state: "unavailable", version: null });
    expect(found.database.error).toBeString();
    expect(found.storage.directory).toBe(directory);
    expect(found.versions.core).toBe(corePackage.version);
    const text = run(["info"], directory);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(path);
    expect(text.stdout).toContain(found.database.error!);
  }
});

test("inspection preserves real task data, activity and schema", () => {
  const directory = join(root, "store");
  mkdirSync(directory);
  expect(run(["project", "create", "INFO", "--json"], directory).code).toBe(0);
  expect(run(["task", "create", "INFO", "--title", "Keep this task", "--json"], directory).code).toBe(0);
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
  expect(report(directory).database).toMatchObject({ state: "current", version: currentVersion });
  expect(snapshot()).toEqual(before);
});

test("info classifies unmarked, older and newer files without initializing or upgrading them", () => {
  for (const [version, state] of [[0, "unmarked"], [currentVersion - 1, "older"], [currentVersion + 1, "newer"]] as const) {
    const directory = join(root, state);
    mkdirSync(join(directory, "data"), { recursive: true });
    const path = join(directory, "data", "zinn.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    expect(report(directory).database).toMatchObject({ state, version, latestVersion: currentVersion, error: null });
    const checked = new Database(path);
    expect(checked.query("SELECT name FROM sqlite_schema").all()).toEqual([{ name: "sample" }]);
    expect(checked.query("SELECT value FROM sample").all()).toEqual([{ value: "preserved" }]);
    expect(checked.query("PRAGMA user_version").get()).toEqual({ user_version: version });
    checked.close();
  }
});

test("info sees a committed schema version in WAL while another connection remains open", () => {
  const directory = join(root, "wal-store");
  mkdirSync(join(directory, "data"), { recursive: true });
  const db = new Database(join(directory, "data", "zinn.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
    db.exec(`PRAGMA user_version=${currentVersion - 1}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA user_version=${currentVersion}`);
    expect(report(directory).database).toMatchObject({ state: "current", version: currentVersion, error: null });
    expect(db.query("SELECT * FROM sample").all()).toEqual([{ value: "preserved" }]);
  } finally {
    db.close();
  }
});

test("info rejects unexpected arguments and flags through the normal CLI error path", () => {
  for (const args of [["info", "extra", "--json"], ["info", "--unknown", "--json"]]) {
    const result = run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toBeObject();
  }
});
