import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("labels preserve atomic edits, no-op timestamps, uniqueness, and cascade integrity", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-labels-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, task, label } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const db = getDb();
      assert.equal(db.query("PRAGMA foreign_keys").get().foreign_keys, 1);
      const app = project.create({ key: "APP" }, actor);
      const other = project.create({ key: "OTHER" }, actor);
      const bug = label.create({ name: " bug ", color: "red" }, actor);
      assert.equal(bug.name, "bug");
      assert.equal(bug.description, "");
      const auth = label.create({ name: "auth" }, actor);
      assert.equal(auth.color, "white");
      assert.throws(() => label.create({ name: "bug" }, actor), /already exists/);
      assert.throws(() => label.create({ name: "BUG" }, actor), /already exists/);
      assert.throws(() => label.create({ name: " ", color: "red" }, actor));
      assert.throws(() => label.create({ name: "bad", color: "purple" }, actor));
      assert.throws(() => task.create({ project_id: app.id, title: "Bad", description: null, labelNames: ["missing"] }, actor));
      assert.equal(project.getById(app.id).task_count, 0);
      const first = task.create({ project_id: app.id, title: "First", description: null, labelNames: ["BUG", "bug", "AUTH"] }, actor);
      const second = task.create({ project_id: other.id, title: "Second", description: null, labelNames: ["BuG"] }, actor);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth", "bug"]);
      db.query("UPDATE task SET updated_at = 1").run();
      const renamed = label.edit({ labelName: " BUG ", name: " defect ", color: "blue", description: "Unexpected behavior" }, actor);
      assert.deepEqual(renamed, { ...bug, name: "defect", color: "blue", description: "Unexpected behavior" });
      assert.equal(label.edit({ labelName: "defect", name: "defect", color: "blue" }, actor).id, bug.id);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth", "defect"]);
      assert.deepEqual(task.label.getAll(second.key).map(l => l.name), ["defect"]);
      assert.deepEqual(db.query("SELECT updated_at FROM task ORDER BY id").all(), [{ updated_at: 1 }, { updated_at: 1 }]);
      assert.throws(() => label.edit({ labelName: "DEFECT", name: "AUTH" }, actor), /already exists/);
      assert.equal(label.getByName("DeFeCt").id, bug.id);
      assert.throws(() => label.edit({ labelName: "missing", color: "red" }, actor), /does not exist/);
      assert.throws(() => db.query("INSERT INTO task_label VALUES (?, ?)").run(first.id, bug.id));
      assert.throws(() => db.query("INSERT INTO task_label VALUES (?, ?)").run(first.id, "missing"));
      const unchanged = task.getByKey(first.key);
      const unchangedSecond = task.getByKey(second.key);
      assert.deepEqual(task.label.add({ taskKey: first.key, labelNames: ["defect"] }, actor), unchanged);
      assert.deepEqual(task.label.remove({ taskKey: second.key, labelNames: ["auth"] }, actor), unchangedSecond);
      assert.throws(() => task.edit({ taskKey: first.key, title: "No", addLabelNames: ["missing"] }, actor));
      assert.throws(() => task.edit({ taskKey: first.key, addLabelNames: ["DEFECT"], removeLabelNames: [" defect "] }, actor));
      assert.deepEqual(task.getByKey(first.key), unchanged);
      // Force failure after the task counter and row have been written.
      db.run("CREATE TRIGGER fail_attachment BEFORE INSERT ON task_label BEGIN SELECT RAISE(ABORT, 'attachment failed'); END");
      assert.throws(() => task.create({ project_id: app.id, title: "Rollback", description: null, labelNames: ["defect"] }, actor), /attachment failed/);
      assert.equal(project.getById(app.id).task_count, 1);
      assert.equal(task.getAll({ projectKey: "APP" }).length, 1);
      db.run("DROP TRIGGER fail_attachment");
      // Force failure after attachment changes but before the task update finishes.
      db.run("CREATE TRIGGER fail_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'update failed'); END");
      assert.throws(() => task.edit({ taskKey: first.key, title: "Rollback", removeLabelNames: ["auth"] }, actor), /update failed/);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth", "defect"]);
      assert.equal(task.getByKey(first.key).title, "First");
      db.run("DROP TRIGGER fail_update");
      db.query("UPDATE task SET updated_at = 1 WHERE id = ?").run(first.id);
      const edited = task.edit({ taskKey: first.key, title: "Edited", removeLabelNames: ["auth"] }, actor);
      assert.ok(edited.updated_at > 1);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["defect"]);
      task.archive(first.key, actor);
      task.label.add({ taskKey: first.key, labelNames: ["AUTH"] }, actor);
      const recased = label.edit({ labelName: "DEFECT", name: "Defect" }, actor);
      assert.equal(recased.id, bug.id);
      assert.equal(recased.name, "Defect");
      label.delete({ name: "dEfEcT" }, actor);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth"]);
      assert.equal(task.label.getAll(second.key).length, 0);
      assert.equal(task.getAll({ archive: "all" }).length, 2);
      assert.throws(() => label.delete({ name: "defect" }, actor), /does not exist/);
      task.label.add({ taskKey: second.key, labelNames: ["auth"] }, actor);
      task.delete(first.key, actor);
      assert.equal(db.query("SELECT COUNT(*) AS n FROM task_label WHERE task_id = ?").get(first.id).n, 0);
      assert.equal(task.label.getAll(second.key).length, 1);
      project.delete("OTHER", actor);
      assert.equal(db.query("SELECT COUNT(*) AS n FROM task_label").get().n, 0);
      assert.equal(label.getAll().length, 1);
      assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task lists filter by every requested label without changing their order", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-label-filters-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { label, project, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const app = project.create({ key: "APP" }, actor);
      const other = project.create({ key: "OTHER" }, actor);
      label.create({ name: "bug" }, actor);
      label.create({ name: "Groom" }, actor);
      task.create({ project_id: app.id, title: "Both", description: null, labelNames: ["bug", "Groom"] }, actor);
      task.create({ project_id: app.id, title: "Bug only", description: null, labelNames: ["bug"] }, actor);
      task.create({ project_id: other.id, title: "Other both", description: null, labelNames: ["bug", "Groom"] }, actor);

      const keys = (options) => task.getAll(options).map((entry) => entry.key);
      assert.deepEqual(keys({ labelNames: ["BUG"] }), ["APP-1", "APP-2", "OTHER-1"]);
      assert.deepEqual(keys({ projectKey: "app", labelNames: ["bug", "groom", "BUG"] }), ["APP-1"]);
      assert.throws(() => task.getAll({ labelNames: ["missing"] }), /does not exist/);
      assert.throws(() => task.getAll({ labelNames: [" "] }), /Label name cannot be blank/);

      task.archive("APP-1", actor);
      assert.deepEqual(keys({ labelNames: ["bug", "groom"] }), ["OTHER-1"]);
      assert.deepEqual(keys({ archive: "archived", labelNames: ["bug", "groom"] }), ["APP-1"]);
      assert.deepEqual(keys({ archive: "all", labelNames: ["bug", "groom"] }), ["APP-1", "OTHER-1"]);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
