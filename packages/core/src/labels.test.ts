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
      const db = getDb();
      assert.equal(db.query("PRAGMA foreign_keys").get().foreign_keys, 1);
      const app = project.create({ key: "APP" });
      const other = project.create({ key: "OTHER" });
      const bug = label.create({ name: " bug ", color: "red" });
      assert.equal(bug.name, "bug");
      assert.equal(bug.description, "");
      const auth = label.create({ name: "auth" });
      assert.equal(auth.color, "white");
      assert.throws(() => label.create({ name: "bug" }), /already exists/);
      assert.throws(() => label.create({ name: " ", color: "red" }));
      assert.throws(() => label.create({ name: "bad", color: "purple" }));
      assert.throws(() => task.create({ project_id: app.id, title: "Bad", description: null, labelNames: ["missing"] }));
      assert.equal(project.getById(app.id).task_count, 0);
      const first = task.create({ project_id: app.id, title: "First", description: null, labelNames: ["bug", "bug", "auth"] });
      const second = task.create({ project_id: other.id, title: "Second", description: null, labelNames: ["bug"] });
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth", "bug"]);
      assert.throws(() => db.query("INSERT INTO task_label VALUES (?, ?)").run(first.id, bug.id));
      assert.throws(() => db.query("INSERT INTO task_label VALUES (?, ?)").run(first.id, "missing"));
      const unchanged = task.getByKey(first.key);
      assert.deepEqual(task.label.add({ taskKey: first.key, labelNames: ["bug"] }), unchanged);
      assert.deepEqual(task.label.remove({ taskKey: second.key, labelNames: ["auth"] }), second);
      assert.throws(() => task.edit({ taskKey: first.key, title: "No", addLabelNames: ["missing"] }));
      assert.throws(() => task.edit({ taskKey: first.key, addLabelNames: ["bug"], removeLabelNames: [" bug "] }));
      assert.deepEqual(task.getByKey(first.key), unchanged);
      // Force failure after the task counter and row have been written.
      db.run("CREATE TRIGGER fail_attachment BEFORE INSERT ON task_label BEGIN SELECT RAISE(ABORT, 'attachment failed'); END");
      assert.throws(() => task.create({ project_id: app.id, title: "Rollback", description: null, labelNames: ["bug"] }), /attachment failed/);
      assert.equal(project.getById(app.id).task_count, 1);
      assert.equal(task.getAll({ projectKey: "APP" }).length, 1);
      db.run("DROP TRIGGER fail_attachment");
      // Force failure after attachment changes but before the task update finishes.
      db.run("CREATE TRIGGER fail_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'update failed'); END");
      assert.throws(() => task.edit({ taskKey: first.key, title: "Rollback", removeLabelNames: ["auth"] }), /update failed/);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth", "bug"]);
      assert.equal(task.getByKey(first.key).title, "First");
      db.run("DROP TRIGGER fail_update");
      db.query("UPDATE task SET updated_at = 1 WHERE id = ?").run(first.id);
      const edited = task.edit({ taskKey: first.key, title: "Edited", removeLabelNames: ["auth"] });
      assert.ok(edited.updated_at > 1);
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["bug"]);
      task.archive(first.key);
      task.label.add({ taskKey: first.key, labelNames: ["auth"] });
      label.delete({ name: "bug" });
      assert.deepEqual(task.label.getAll(first.key).map(l => l.name), ["auth"]);
      assert.equal(task.label.getAll(second.key).length, 0);
      assert.equal(task.getAll({ archive: "all" }).length, 2);
      assert.throws(() => label.delete({ name: "bug" }), /does not exist/);
      task.label.add({ taskKey: second.key, labelNames: ["auth"] });
      task.delete(first.key);
      assert.equal(db.query("SELECT COUNT(*) AS n FROM task_label WHERE task_id = ?").get(first.id).n, 0);
      assert.equal(task.label.getAll(second.key).length, 1);
      project.delete("OTHER");
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
