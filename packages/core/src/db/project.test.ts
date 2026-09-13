import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Task } from "../types";

const TEMP_DIR_ROOT = tmpdir();
const PREFIX = join(TEMP_DIR_ROOT, "zinntest-");
const TEST_DIR = mkdtempSync(PREFIX);
process.env.ZINN_DIR = TEST_DIR;

// ? Dynamic so env is set before `MAIN_DIR` constant is initialized.
const project = await import("./project");
const column = await import("./column");
const task = await import("./task");

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

function createTask(title: string) {
  const suffix = crypto.randomUUID();
  const taskProject = project.create({ key: `P${suffix.replaceAll("-", "")}`, name: title })!;
  const taskColumn = {
    id: crypto.randomUUID(),
    project_id: taskProject.id,
    name: "Backlog",
    column_order: "a0",
  };
  column.create(taskColumn);

  const created: Omit<Task, "archived_at"> = {
    id: crypto.randomUUID(),
    project_id: taskProject.id,
    column_id: taskColumn.id,
    number: 1,
    title,
    description: "original description",
    task_order: "a0",
    created_at: 10,
    updated_at: 10,
  };
  task.create(created);

  return created;
}

test("task.update changes supplied fields and preserves omitted fields", () => {
  const created = createTask("original title");

  const updated = task.update({
    id: created.id,
    title: "updated title",
    description: null,
    updated_at: 20,
  });

  expect(updated).toEqual({
    ...created,
    title: "updated title",
    description: null,
    updated_at: 20,
    archived_at: null,
  });
});

test("task.update distinguishes null from an omitted field", () => {
  const created = createTask("archivable task");

  const archived = task.update({ id: created.id, archived_at: 30, updated_at: 30 })!;
  const unarchived = task.update({ id: created.id, archived_at: null, updated_at: 40 });

  expect(archived.archived_at).toBe(30);
  expect(archived.description).toBe("original description");
  expect(unarchived?.archived_at).toBeNull();
  expect(unarchived?.description).toBe("original description");
});

test("task lists exclude archived tasks by default and support explicit filters", () => {
  const created = createTask("filtered task");
  task.update({ id: created.id, archived_at: 50, updated_at: 50 });

  expect(task.getAll().map(({ id }) => id)).not.toContain(created.id);
  expect(task.getAllByProjectId(created.project_id)).toEqual([]);
  expect(task.getAll("archived").map(({ id }) => id)).toContain(created.id);
  expect(task.getAllByProjectId(created.project_id, "all").map(({ id }) => id)).toEqual([
    created.id,
  ]);
});

test("task.getLastByColumnId ignores archived tasks", () => {
  const first = createTask("active ordering tail");
  const archived = {
    ...first,
    id: crypto.randomUUID(),
    number: 2,
    title: "archived ordering tail",
    task_order: "z0",
  };
  task.create(archived);
  task.update({ id: archived.id, archived_at: 50, updated_at: 50 });

  expect(task.getLastByColumnId(first.column_id)?.id).toBe(first.id);
});
