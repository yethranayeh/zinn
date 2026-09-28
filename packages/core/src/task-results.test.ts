import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("public task results include keys across reads, mutations, and no-ops; DB rows stay raw", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      import * as dbTask from ${JSON.stringify(new URL("./db/task.ts", import.meta.url).pathname)};
      const app = project.create({ key: "app" }, actor);
      const other = project.create({ key: "other" }, actor);
      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      assert.equal(first.key, "APP-1");
      task.create({ project_id: app.id, title: "Second", description: null }, actor);
      task.create({ project_id: other.id, title: "Other", description: null }, actor);
      assert.equal(task.getByKey("app-1").key, "APP-1");
      assert.deepEqual(task.getAll().map(t => t.key).sort(), ["APP-1", "APP-2", "OTHER-1"]);
      assert.deepEqual(task.getAll({ projectKey: "app" }).map(t => t.key).sort(), ["APP-1", "APP-2"]);
      const check = (result) => { assert.equal(result.key, "APP-1"); return result; };
      check(task.edit({ taskKey: "APP-1", title: "Edited" }, actor));
      const edited = task.getByKey("APP-1");
      assert.deepEqual(check(task.edit({ taskKey: "APP-1", title: "Edited" }, actor)), edited);
      check(task.order({ taskKey: "APP-1", direction: "bottom" }, actor));
      const ordered = task.getByKey("APP-1");
      assert.deepEqual(check(task.order({ taskKey: "APP-1", direction: "bottom" }, actor)), ordered);
      check(task.order({ taskKey: "APP-1", direction: "before", targetTaskKey: "APP-1" }, actor));
      check(task.move({ taskKey: "APP-1", targetColumn: "TODO" }, actor));
      const moved = task.getByKey("APP-1");
      assert.deepEqual(check(task.move({ taskKey: "APP-1", targetColumn: "TODO" }, actor)), moved);
      const archived = check(task.archive("APP-1", actor));
      assert.deepEqual(check(task.archive("APP-1", actor)), archived);
      assert.equal(task.getAll({ archive: "archived" })[0].key, "APP-1");
      assert.equal(task.getAll({ projectKey: "app", archive: "archived" })[0].key, "APP-1");
      assert.equal(task.getAll({ archive: "all" }).length, 3);
      const active = check(task.unarchive("APP-1", actor));
      assert.deepEqual(check(task.unarchive("APP-1", actor)), active);
      assert.equal("key" in dbTask.getById(first.id), false);
      assert.equal("key" in dbTask.getAll()[0], false);
      check(task.delete("APP-1", actor));
      assert.equal(dbTask.getById(first.id), null);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task lists across projects follow project key, column order, and task order", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const later = project.create({ key: "BBB" }, actor);
      const earlier = project.create({ key: "AAA" }, actor);
      for (const title of ["One", "Two", "Three"]) {
        task.create({ project_id: later.id, title, description: null }, actor);
      }
      task.create({ project_id: earlier.id, title: "Only", description: null }, actor);
      task.move({ taskKey: "BBB-1", targetColumn: "In Progress" }, actor);
      task.order({ taskKey: "BBB-3", direction: "top" }, actor);
      task.archive("BBB-2", actor);
      assert.deepEqual(task.getAll().map(t => t.key), ["AAA-1", "BBB-3", "BBB-1"]);
      task.unarchive("BBB-2", actor);
      task.order({ taskKey: "BBB-2", direction: "top" }, actor);
      assert.deepEqual(task.getAll().map(t => t.key), ["AAA-1", "BBB-2", "BBB-3", "BBB-1"]);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
