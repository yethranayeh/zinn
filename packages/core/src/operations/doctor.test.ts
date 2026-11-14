import type { Database } from "../sqlite/database.js";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { comment, label, project, task } from "../../index.js";
import { doctor } from "./doctor.js";
import { openDatabase } from "../sqlite/bun.ts";
import { latestVersion, MIGRATIONS } from "../migrations/registry.js";
import { snapshot } from "../migrations/testing.js";
import { withStore } from "../testing.js";

// ZINN-134: zinn doctor's core checks.

let root: string;
let home: string;
let cwd: string;
let store: string;
let databasePath: string;
const currentVersion = latestVersion(MIGRATIONS);
const actor = { name: "Doctor Test", email: "doctor@example.test", kind: "human" as const };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zinn-doctor-"));
  home = join(root, "home");
  cwd = join(root, "repo");
  store = join(root, "store");
  databasePath = join(store, "data", "zinn.sqlite");
  mkdirSync(home);
  mkdirSync(cwd);
  mkdirSync(store);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function check(env: Record<string, string> = { ZINN_DIR: store }) {
  return doctor.check({ home, cwd, env });
}

function statuses(checks: ReturnType<typeof check>) {
  return Object.fromEntries(checks.map(({ id, status }) => [id, status]));
}

/** A store with tasks, a task with no description, comments and an archived task. */
function seedStore() {
  withStore(store, () => {
    const app = project.create({ key: "APP" }, actor);
    task.create({ project_id: app.id, title: "First", description: "With a description" }, actor);
    task.create({ project_id: app.id, title: "Second" }, actor);
    task.create({ project_id: app.id, title: "Archived", description: "Old" }, actor);
    comment.create({ taskKey: "APP-1", text: "A comment" }, actor);
    comment.create({ taskKey: "APP-1", text: "Another comment" }, actor);
    comment.create({ taskKey: "APP-3", text: "Before archiving" }, actor);
    task.archive("APP-3", actor);
    label.create({ name: "unused", color: "red" }, actor);
  });
}

function withOpen<T>(action: (db: Database) => T): T {
  const db = openDatabase(databasePath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function change(sql: string) {
  withOpen((db) => db.exec(sql));
}

function taskId(key: number) {
  return withOpen((db) => db.query<{ id: string }>("SELECT id FROM task WHERE number = $number").get({ $number: key })!.id);
}

/** Runs doctor and checks that the database's rows and schema are the same before and after. */
function checkUnchanged() {
  const before = withOpen(snapshot);
  const checks = check();
  expect(withOpen(snapshot)).toEqual(before);
  return checks;
}

function expectRemedy(checks: ReturnType<typeof check>, id: string, command: string) {
  expect(checks.find((found) => found.id === id)?.remedy).toContain(command);
}

test("a healthy store passes every check and stays unchanged", () => {
  seedStore();
  const checks = checkUnchanged();
  expect(statuses(checks)).toEqual({
    settings: "ok",
    store_folder: "ok",
    database: "ok",
    integrity: "ok",
    foreign_keys: "ok",
    search_index: "ok",
  });
  expect(checks.every((found) => found.remedy === null)).toBe(true);
});

test("no database yet is ok, and nothing is created", () => {
  const before = readdirSync(root, { recursive: true });
  expect(statuses(check({}))).toEqual({ settings: "ok", store_folder: "ok", database: "ok" });
  expect(statuses(check())).toEqual({ settings: "ok", store_folder: "ok", database: "ok" });
  expect(readdirSync(root, { recursive: true })).toEqual(before);
  expect(existsSync(join(home, ".zinn"))).toBe(false);
});

test("an unusable settings file that leaves the store unknown leaves out the store and database checks", () => {
  const path = join(home, ".zinn", "settings.json");
  mkdirSync(dirname(path));
  writeFileSync(path, "{");
  const checks = check({});
  expect(checks.map(({ id, status }) => [id, status])).toEqual([["settings", "problem"]]);
  expect(checks[0]!.remedy).toContain(path);
});

test("a missing explicit store folder is a problem naming mkdir, and the database checks are left out", () => {
  const missing = join(root, "missing");
  const checks = check({ ZINN_DIR: missing });
  expect(statuses(checks)).toEqual({ settings: "ok", store_folder: "problem" });
  expectRemedy(checks, "store_folder", "mkdir -p");
  expectRemedy(checks, "store_folder", missing);
  expect(existsSync(missing)).toBe(false);
});

test("newer, older and unmarked databases", () => {
  seedStore();

  change(`PRAGMA user_version = ${currentVersion + 1}`);
  const newer = checkUnchanged();
  expect(statuses(newer)).toEqual({ settings: "ok", store_folder: "ok", database: "problem", integrity: "ok", foreign_keys: "ok" });

  change(`PRAGMA user_version = ${currentVersion - 1}`);
  const older = checkUnchanged();
  expect(statuses(older)).toEqual({ settings: "ok", store_folder: "ok", database: "ok", integrity: "ok", foreign_keys: "ok" });
  expect(older.find(({ id }) => id === "database")!.message).toContain("zinn migrate");

  change("PRAGMA user_version = 0");
  const unmarked = checkUnchanged();
  expect(statuses(unmarked)).toEqual({ settings: "ok", store_folder: "ok", database: "problem", integrity: "ok", foreign_keys: "ok" });
  expectRemedy(unmarked, "database", "zinn restore");
});

test("a file that is not SQLite is a database problem naming restore, with no table checks", () => {
  mkdirSync(dirname(databasePath));
  writeFileSync(databasePath, "not a database ".repeat(200));
  const checks = check();
  expect(statuses(checks)).toEqual({ settings: "ok", store_folder: "ok", database: "problem" });
  expectRemedy(checks, "database", "zinn restore");
});

test("a corrupted index is an integrity problem naming restore", () => {
  seedStore();
  const { rootpage, pageSize } = withOpen((db) => {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      rootpage: db.query<{ rootpage: number }>("SELECT rootpage FROM sqlite_schema WHERE name = 'sqlite_autoindex_label_2'").get()!.rootpage,
      pageSize: db.query<{ page_size: number }>("PRAGMA page_size").get()!.page_size,
    };
  });
  const bytes = readFileSync(databasePath);
  const page = bytes.subarray((rootpage - 1) * pageSize, rootpage * pageSize);
  // The label name index no longer matches the label table.
  page.write("unusex", page.indexOf("unused"));
  writeFileSync(databasePath, bytes);

  const checks = check();
  expect(statuses(checks)).toMatchObject({ database: "ok", integrity: "problem" });
  expectRemedy(checks, "integrity", "zinn restore");
});

test("a foreign key violation is a problem naming restore", () => {
  seedStore();
  change("PRAGMA foreign_keys = OFF; DELETE FROM project");
  const checks = checkUnchanged();
  expect(statuses(checks)).toMatchObject({ integrity: "ok", foreign_keys: "problem" });
  expectRemedy(checks, "foreign_keys", "zinn restore");
});

test("a missing parent table is a foreign key problem", () => {
  seedStore();
  // No task has a label, so only the parent table check finds the broken link.
  change("PRAGMA foreign_keys = OFF; DELETE FROM label; DROP TABLE label");
  const checks = checkUnchanged();
  expect(statuses(checks)).toMatchObject({ integrity: "ok", foreign_keys: "problem" });
  expectRemedy(checks, "foreign_keys", "zinn restore");
});

for (const [name, staleChange] of [
  ["a task missing from the index", () => change(`DELETE FROM task_search WHERE task_id = '${taskId(2)}'`)],
  ["an entry for a deleted task", () => change("INSERT INTO task_search (task_id, title, description, comments) VALUES ('deleted', 'Gone', NULL, '')")],
  ["a changed title", () => change("UPDATE task SET title = 'Changed' WHERE number = 1")],
  ["a missing task_search table", () => change("DROP TABLE task_search")],
] as const) {
  test(`a stale search index is a warning naming reindex: ${name}`, () => {
    seedStore();
    staleChange();
    const checks = checkUnchanged();
    expect(statuses(checks)).toEqual({
      settings: "ok",
      store_folder: "ok",
      database: "ok",
      integrity: "ok",
      foreign_keys: "ok",
      search_index: "warning",
    });
    expectRemedy(checks, "search_index", "zinn reindex");
  });
}

test("committed data still in the WAL is read, and the WAL is left to its writer", () => {
  seedStore();
  const writer = openDatabase(databasePath);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec(`DELETE FROM task_search WHERE task_id = '${taskId(1)}'`);
    const walSize = readFileSync(`${databasePath}-wal`).length;
    expect(walSize).toBeGreaterThan(0);

    expect(statuses(check()).search_index).toBe("warning");
    expect(readFileSync(`${databasePath}-wal`).length).toBe(walSize);
  } finally {
    writer.close();
  }
});

test("a cleanly closed database with no -wal or -shm files is checked", () => {
  seedStore();
  // Some SQLite builds, such as macOS's, keep the side files after a clean close. With the WAL checkpointed and no connection open, they hold nothing.
  change("PRAGMA wal_checkpoint(TRUNCATE)");
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  const checks = checkUnchanged();
  expect(checks.every(({ status }) => status === "ok")).toBe(true);
  expect(checks.map(({ id }) => id)).toContain("search_index");
});
