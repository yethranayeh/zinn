import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { info } from "./info.js";
import { resolveDatabasePath } from "../database-path.js";
import { resolveSettings } from "../settings.js";
import { openDatabase } from "../sqlite/bun.ts";
import { withDatabaseInspection } from "../migrations/classify.js";
import { latestVersion, MIGRATIONS } from "../migrations/registry.js";

let root: string;
let home: string;
let cwd: string;
const currentVersion = latestVersion(MIGRATIONS);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zinn-info-"));
  home = join(root, "home");
  cwd = join(root, "repo", "nested", "app");
  mkdirSync(home);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "repo", ".git"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("ZINN-133: a default store without a database reports paths and every location tried without creating files", () => {
  const before = readdirSync(root, { recursive: true });
  const report = info.get({ home, cwd, env: {} });
  expect(report.storage).toMatchObject({ directory: join(home, ".zinn"), source: "default", exists: false, error: null });
  expect(report.database).toMatchObject({ state: "absent", version: 0, latestVersion: currentVersion, error: null });
  expect(report.defaultProject).toEqual({ key: null, settingsPath: null, error: null });
  expect(report.settingsFiles.map((file) => file.path)).toEqual([
    join(home, ".zinn", "settings.json"),
    join(cwd, "zinn.local.json"),
    join(root, "repo", "nested", "zinn.local.json"),
    join(root, "repo", "zinn.local.json"),
  ]);
  expect(report.settingsFiles.every((file) => file.state === "missing")).toBe(true);
  expect(readdirSync(root, { recursive: true })).toEqual(before);
});

test("local settings select relative storage and discovery stops at the nearest file", () => {
  const global = join(home, ".zinn", "settings.json");
  const nearest = join(root, "repo", "nested", "zinn.local.json");
  settings(global, { defaultProject: "GLOBAL" });
  settings(nearest, { storage: { directory: "store" }, defaultProject: "LOCAL" });
  settings(join(root, "repo", "zinn.local.json"), "invalid and never read");
  const report = info.get({ home, cwd, env: {} });
  expect(report.storage).toMatchObject({ directory: join(root, "repo", "nested", "store"), source: "local", settingsPath: nearest, exists: false });
  expect(report.defaultProject).toEqual({ key: "LOCAL", settingsPath: nearest, error: null });
  expect(report.settingsFiles.map((file) => file.path)).toEqual([global, join(cwd, "zinn.local.json"), nearest]);
});

test("ZINN_DIR reports its own settings and marks home and local files as not read", () => {
  const directory = join(root, "selected");
  settings(join(directory, "settings.json"), { defaultProject: "SELECTED", storage: { directory: "ignored" } });
  settings(join(home, ".zinn", "settings.json"), "invalid and not read");
  settings(join(cwd, "zinn.local.json"), "invalid and not read");
  const report = info.get({ home, cwd, env: { ZINN_DIR: directory } });
  expect(report.storage).toMatchObject({ directory, source: "env", exists: true, error: null });
  expect(report.defaultProject).toEqual({ key: "SELECTED", settingsPath: join(directory, "settings.json"), error: null });
  expect(report.settingsFiles.map((file) => file.state)).toEqual(["found", "not-read", "not-read"]);
  expect(existsSync(join(directory, "data"))).toBe(false);
});

test("a broken nearest local file makes effective values unavailable without falling back", () => {
  settings(join(home, ".zinn", "settings.json"), { defaultProject: "GLOBAL", storage: { directory: "global-store" } });
  settings(join(cwd, "zinn.local.json"), "{");
  settings(join(root, "repo", "nested", "zinn.local.json"), { defaultProject: "ANCESTOR" });
  const inputs = { home, cwd, env: {} };
  const report = info.get(inputs);
  expect(report.storage.directory).toBeNull();
  expect(report.defaultProject.key).toBeNull();
  expect(report.storage.error).toContain(join(cwd, "zinn.local.json"));
  expect(report.defaultProject.error).toBe(report.storage.error);
  expect(report.settingsFiles.map((file) => file.state)).toEqual(["found", "error"]);
  expect(report.database.state).toBe("unavailable");
  expect(() => resolveSettings(inputs)).toThrow();
});

test("known environment storage survives invalid selected settings", () => {
  const directory = join(root, "selected");
  settings(join(directory, "settings.json"), { defaultProject: 42 });
  const inputs = { home, cwd, env: { ZINN_DIR: directory } };
  const report = info.get(inputs);
  expect(report.storage).toMatchObject({ directory, source: "env", error: null });
  expect(report.database.state).toBe("absent");
  expect(report.defaultProject.key).toBeNull();
  expect(report.defaultProject.error).toContain(join(directory, "settings.json"));
  expect(() => resolveSettings(inputs)).toThrow();
});

test("valid local values remain known when a global file is unusable", () => {
  const globalPath = join(home, ".zinn", "settings.json");
  settings(globalPath, "{");
  settings(join(cwd, "zinn.local.json"), { storage: { directory: "store" } });
  const report = info.get({ home, cwd, env: {} });
  expect(report.storage.directory).toBe(join(cwd, "store"));
  expect(report.defaultProject.error).toContain(globalPath);
  settings(join(cwd, "zinn.local.json"), { storage: { directory: "store" }, defaultProject: "LOCAL" });
  const complete = info.get({ home, cwd, env: {} });
  expect(complete.defaultProject).toMatchObject({ key: "LOCAL", error: null });
  expect(complete.settingsFiles[0]?.state).toBe("error");
});

test("a settings path that cannot be read is an error, not a missing file", () => {
  mkdirSync(join(cwd, "zinn.local.json"));
  const report = info.get({ home, cwd, env: {} });
  expect(report.settingsFiles.at(-1)?.state).toBe("error");
  expect(report.storage.directory).toBeNull();
});

test("a missing explicit directory and a non-SQLite database remain inspectable", () => {
  const directory = join(root, "missing");
  const missing = info.get({ home, cwd, env: { ZINN_DIR: directory } });
  expect(missing.storage.exists).toBe(false);
  expect(missing.database.state).toBe("absent");
  expect(existsSync(directory)).toBe(false);
  mkdirSync(join(directory, "data"), { recursive: true });
  writeFileSync(join(directory, "data", "zinn.sqlite"), "not a database");
  const invalid = info.get({ home, cwd, env: { ZINN_DIR: directory } });
  expect(invalid.database.state).toBe("unavailable");
  expect(invalid.database.error).toBeString();
  expect(invalid.storage.directory).toBe(directory);
  expect(invalid.coreVersion).toBeString();
});

test("schema inspection preserves records and schema for unmarked, older, current and newer files", () => {
  const directory = join(root, "store");
  mkdirSync(join(directory, "data"), { recursive: true });
  const path = join(directory, "data", "zinn.sqlite");
  for (const [version, state] of [[0, "unmarked"], [currentVersion - 1, "older"], [currentVersion, "current"], [currentVersion + 1, "newer"]] as const) {
    const db = openDatabase(path);
    db.exec("CREATE TABLE IF NOT EXISTS sample(value TEXT); DELETE FROM sample; INSERT INTO sample VALUES ('preserved');");
    db.exec(`PRAGMA user_version=${version}`);
    const schema = db.query("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    db.close();
    const report = info.get({ home, cwd, env: { ZINN_DIR: directory } });
    expect(report.database).toMatchObject({ path, version, state, latestVersion: currentVersion, error: null });
    const checked = openDatabase(path);
    expect(checked.query("SELECT * FROM sample").all()).toEqual([{ value: "preserved" }]);
    expect(checked.query("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(checked.query("PRAGMA user_version").get()).toEqual({ user_version: version });
    checked.close();
  }
});

test("the shared inspection connection refuses writes and never creates a missing database", () => {
  const path = join(root, "sample.sqlite");
  const resolvedPath = resolveDatabasePath(path);
  const db = openDatabase(path);
  db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
  db.close();
  withDatabaseInspection(resolvedPath, (inspected) => {
    expect(inspected.query("SELECT * FROM sample").all()).toEqual([{ value: "preserved" }]);
    expect(() => inspected.exec("UPDATE sample SET value='changed'")).toThrow();
    expect(() => inspected.exec("CREATE TABLE unexpected(value TEXT)")).toThrow();
    expect(() => inspected.exec("PRAGMA user_version=99")).toThrow();
  });
  const missing = join(root, "absent.sqlite");
  const resolvedMissing = resolveDatabasePath(missing);
  expect(() => withDatabaseInspection(resolvedMissing, () => {})).toThrow();
  expect(existsSync(missing)).toBe(false);
});

// ? ZINN-347: the telemetry section of the report.
test("ZINN-347: a default store reports local telemetry and a missing folder without creating it", () => {
  const before = readdirSync(root, { recursive: true });
  const report = info.get({ home, cwd, env: {} });
  expect(report.telemetry).toEqual({
    mode: "local",
    source: "default",
    settingsPath: null,
    maxMegabytes: 100,
    maxAgeDays: 90,
    directory: join(home, ".zinn", "telemetry"),
    exists: false,
    sizeBytes: 0,
    error: null,
  });
  expect(readdirSync(root, { recursive: true })).toEqual(before);
});

test("ZINN-347: DO_NOT_TRACK=1 turns telemetry off and any other value is ignored", () => {
  expect(info.get({ home, cwd, env: { DO_NOT_TRACK: "1" } }).telemetry).toMatchObject({ mode: "off", source: "DO_NOT_TRACK", settingsPath: null });
  expect(info.get({ home, cwd, env: { DO_NOT_TRACK: "true" } }).telemetry).toMatchObject({ mode: "local", source: "default" });
});

test("ZINN-347: settings choose the mode over DO_NOT_TRACK, and a file that sets only the cap keeps the source", () => {
  const global = join(home, ".zinn", "settings.json");
  const local = join(root, "repo", "zinn.local.json");
  settings(global, { telemetry: { mode: "local" } });
  expect(info.get({ home, cwd, env: { DO_NOT_TRACK: "1" } }).telemetry).toMatchObject({ mode: "local", source: "settings", settingsPath: global, maxMegabytes: 100 });
  settings(local, { telemetry: { mode: "off", maxMegabytes: 8 } });
  expect(info.get({ home, cwd, env: {} }).telemetry).toMatchObject({ mode: "off", source: "settings", settingsPath: local, maxMegabytes: 8 });
  settings(local, { telemetry: { maxMegabytes: 9 } });
  expect(info.get({ home, cwd, env: {} }).telemetry).toMatchObject({ mode: "local", source: "settings", settingsPath: global, maxMegabytes: 9 });
  settings(global, {});
  expect(info.get({ home, cwd, env: {} }).telemetry).toMatchObject({ mode: "local", source: "default", settingsPath: null, maxMegabytes: 9 });
});

test("ZINN-347: the folder size sums the files directly inside it and skips nested folders", () => {
  const directory = join(root, "selected");
  mkdirSync(join(directory, "telemetry", "nested"), { recursive: true });
  writeFileSync(join(directory, "telemetry", "2026-11-05.jsonl"), "12345");
  writeFileSync(join(directory, "telemetry", "2026-11-06.jsonl"), "678");
  writeFileSync(join(directory, "telemetry", "nested", "ignored.jsonl"), "not counted");
  expect(info.get({ home, cwd, env: { ZINN_DIR: directory } }).telemetry).toMatchObject({ directory: join(directory, "telemetry"), exists: true, sizeBytes: 8, error: null });
});

test("ZINN-347: a telemetry path that is not a folder is reported like the storage folder", () => {
  const directory = join(root, "selected");
  mkdirSync(directory);
  writeFileSync(join(directory, "telemetry"), "a file");
  expect(info.get({ home, cwd, env: { ZINN_DIR: directory } }).telemetry).toMatchObject({ directory: join(directory, "telemetry"), exists: false, sizeBytes: null, error: `${join(directory, "telemetry")} is not a directory` });
});

test.skipIf(process.getuid?.() === 0 || process.platform === "win32")("ZINN-347: a folder that cannot be read gives no size and an error", () => {
  const directory = join(root, "selected");
  const telemetry = join(directory, "telemetry");
  mkdirSync(telemetry, { recursive: true });
  chmodSync(telemetry, 0o000);
  try {
    expect(info.get({ home, cwd, env: { ZINN_DIR: directory } }).telemetry).toMatchObject({ exists: true, sizeBytes: null, error: expect.any(String) });
  } finally {
    chmodSync(telemetry, 0o700);
  }
});

test("ZINN-347: an unusable selected settings file leaves the setting unknown but the folder known", () => {
  const directory = join(root, "selected");
  const path = join(directory, "settings.json");
  settings(path, { telemetry: { maxMegabytes: "1G" } });
  const report = info.get({ home, cwd, env: { ZINN_DIR: directory, DO_NOT_TRACK: "1" } });
  expect(report.telemetry).toMatchObject({ mode: null, source: null, settingsPath: null, maxMegabytes: null, directory: join(directory, "telemetry"), exists: false, sizeBytes: 0 });
  expect(report.telemetry.error).toBe(report.storage.error ?? report.defaultProject.error);
  expect(report.telemetry.error).toContain(path);
});

test("ZINN-347: a broken nearest local file makes every telemetry fact unavailable", () => {
  settings(join(home, ".zinn", "settings.json"), { telemetry: { mode: "off", maxMegabytes: 4 } });
  settings(join(cwd, "zinn.local.json"), "{");
  const report = info.get({ home, cwd, env: {} });
  expect(report.telemetry).toEqual({ mode: null, source: null, settingsPath: null, maxMegabytes: null, maxAgeDays: null, directory: null, exists: null, sizeBytes: null, error: report.storage.error });
  expect(report.telemetry.error).toContain(join(cwd, "zinn.local.json"));
});

test("ZINN-347: a field the unusable global file could have set is unknown while the local file's fields stay known", () => {
  const globalPath = join(home, ".zinn", "settings.json");
  settings(globalPath, "{");
  settings(join(cwd, "zinn.local.json"), { storage: { directory: "store" }, telemetry: { mode: "off" } });
  const report = info.get({ home, cwd, env: {} });
  expect(report.telemetry).toMatchObject({ mode: "off", source: "settings", maxMegabytes: null, directory: join(cwd, "store", "telemetry") });
  expect(report.telemetry.error).toContain(globalPath);
});

test("ZINN-347: a storage directory that cannot be resolved leaves the folder unknown and the setting resolved", () => {
  settings(join(home, ".zinn", "settings.json"), { storage: { directory: join(tmpdir(), "..", "zinn-outside-temporary") }, telemetry: { mode: "off", maxMegabytes: 2 } });
  const report = info.get({ home, cwd, env: { NODE_ENV: "test" } });
  expect(report.storage.error).toBeString();
  expect(report.telemetry).toMatchObject({ mode: "off", source: "settings", maxMegabytes: 2, directory: null, exists: null, sizeBytes: null, error: report.storage.error });
});
