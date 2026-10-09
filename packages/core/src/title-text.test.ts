import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("normalized titles persist before no-op detection, activity and search; body text keeps formatting", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-title-text-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column, label, task, comment } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const actor = { name: "Test", email: null, kind: "human" };
      const body = "\\n  Body text\\n";
      const app = project.create({ key: "APP", name: " App ", description: body }, actor);
      const next = column.create({ projectKey: "APP", name: " Next " }, actor);
      const bug = label.create({ name: " bug ", description: body }, actor);
      const first = task.create({ project_id: app.id, title: " First ", description: body, columnName: " Next ", labelNames: [" bug "] }, actor);
      const note = comment.create({ taskKey: first.key, text: body }, actor);
      assert.equal(app.name, "App");
      assert.equal(next.name, "Next");
      assert.equal(bug.name, "bug");
      assert.equal(first.title, "First");
      assert.equal(first.column_id, next.id);
      assert.equal(app.description, body);
      assert.equal(bug.description, body);
      assert.equal(first.description, body);
      assert.equal(note.text, body);
      const db = getDb();
      const currentProject = project.getByKey("APP");
      const currentTask = task.getByKey(first.key);
      const before = db.query("SELECT * FROM activity ORDER BY id").all();
      assert.deepEqual(project.edit({ projectKey: "APP", name: " App " }, actor), currentProject);
      assert.deepEqual(column.edit({ projectKey: "APP", columnName: " Next ", name: " Next " }, actor), next);
      assert.deepEqual(label.edit({ labelName: " bug ", name: " bug " }, actor), bug);
      assert.deepEqual(task.edit({ taskKey: first.key, title: " First " }, actor), currentTask);
      assert.deepEqual(task.move({ taskKey: first.key, targetColumn: " Next " }, actor), currentTask);
      assert.deepEqual(task.moveMany({ taskKeys: [first.key], targetColumn: " Next " }, actor), [{ task: currentTask, changed: false }]);
      assert.deepEqual(db.query("SELECT * FROM activity ORDER BY id").all(), before);
      assert.deepEqual(task.getAll({ columnName: " Next " }).map(t => t.key), [first.key]);
      for (const targetColumn of [" Next\\n", "\\tNext", " "]) {
        assert.throws(() => task.move({ taskKey: first.key, targetColumn }, actor), /Column name/);
        assert.throws(() => task.moveMany({ taskKeys: [first.key], targetColumn }, actor), /Column name/);
      }
      assert.equal(task.edit({ taskKey: first.key, title: " Renamed " }, actor).title, "Renamed");
      assert.deepEqual(task.search({ query: "Renamed" }).tasks.map(t => t.key), [first.key]);
      const changes = JSON.parse(db.query("SELECT changes FROM activity WHERE entity_id = ? AND action = 'edit' ORDER BY id DESC LIMIT 1").get(first.id).changes);
      assert.deepEqual(changes.title, ["First", "Renamed"]);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
