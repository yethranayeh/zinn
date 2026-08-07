import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR_ROOT = tmpdir();
const PREFIX = join(TEMP_DIR_ROOT, "zinntest-");
const TEST_DIR = mkdtempSync(PREFIX);
process.env.ZINN_DIR = TEST_DIR;

// ? Dynamic so env is set before `MAIN_DIR` constant is initialized.
const project = await import("./project");

afterAll(() => {
  if (!TEST_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("project.create can establish a project", () => {
  const created = project.create({ key: "WIP", name: "Work In Progress" });

  expect(created).not.toBeNull();
  expect(created?.key).toBe("WIP");
  expect(created?.name).toBe("Work In Progress");
  expect(created?.task_count).toBe(0);
  expect(created?.archived_at).toBeNull();
});

test("project.create standardizes the key", () => {
  const created = project.create({ key: "key", name: "Lowercased Key" });

  expect(created?.key).toBe("KEY");
});

test("project.create rejects a duplicate key", () => {
  expect(project.create({ key: "DUPE", name: "First" })?.key).toBe("DUPE");

  // ? "dupe" standardizes to the already-taken "DUPE".
  expect(() => project.create({ key: "dupe", name: "Second" })).toThrow(
    "UNIQUE constraint failed: project.key",
  );
});

test("project.getById finds an existing project", () => {
  const created = project.create({ key: "BYID", name: "By Id" })!;
  const found = project.getById(created.id);

  expect(found?.id).toEqual(created.id);
});

test("project.getById returns null for an unknown id", () => {
  expect(project.getById("unknwon")).toBeNull();
});

test("project.getByKey is case insensitive for matching", () => {
  const created = project.create({ key: "someKey", name: "Got By Key" })!;

  expect(project.getByKey("SOMEKEY")).toEqual(created);
  expect(project.getByKey("somekey")).toEqual(created);
  expect(project.getByKey("SomEkeY")).toEqual(created);
});

test("project.getByKey returns null for an unknown key", () => {
  expect(project.getByKey("NO")).toBeNull();
});

test("project.incrementTaskCounterById returns the next task number", () => {
  const created = project.create({ key: "COUNT", name: "Counter" })!;

  expect(project.incrementTaskCounterById(created.id)?.task_count).toBe(1);
  expect(project.incrementTaskCounterById(created.id)?.task_count).toBe(2);
  expect(project.getById(created.id)?.task_count).toBe(2);
});

test("project.incrementTaskCounterById returns null for an unknown id", () => {
  expect(project.incrementTaskCounterById("nonexistent")).toBeNull();
});

test("project.deleteByKey removes a project regardless of key casing", () => {
  const created = project.create({ key: "GONE", name: "Gone" })!;

  const result = project.deleteByKey("gone");

  expect(result.changes).toBe(1);
  expect(project.getByKey("GONe")).toBeNull();
  expect(project.getById(created.id)).toBeNull();
});

test("project.deleteByKey doesn't do anything for nonexistent project", () => {
  expect(project.deleteByKey("void").changes).toBe(0);
});
