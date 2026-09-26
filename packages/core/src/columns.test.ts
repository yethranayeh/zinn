import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("column renames keep identity and tasks, reject duplicates, and skip no-op writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-columns-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const db = getDb();
      const app = project.create({ key: "APP", name: "App" });
      project.create({ key: "OTHER" });
      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      const todo = column.getAllByProjectKey("APP")[1];
      task.move({ taskKey: first.key, targetColumn: "todo" }, actor);

      const renamed = column.edit({ projectKey: "app", columnName: "todo", name: " Next up " });
      assert.deepEqual(renamed, { ...todo, name: "Next up" });
      assert.equal(task.getByKey(first.key).column_id, todo.id);
      assert.deepEqual(column.getAllByProjectKey("APP").map(c => c.name), ["Backlog", "Next up", "In Progress", "Review", "Done"]);
      assert.equal(task.move({ taskKey: first.key, targetColumn: "NEXT UP" }, actor).column_id, todo.id);

      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: "NEXT UP" }), { ...todo, name: "NEXT UP" });
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: "done" }), /There is already a "done" column/);
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: " " }), /Column name cannot be blank/);
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "missing", name: "Later" }), /App does not have a column named "missing"/);
      assert.throws(() => column.edit({ projectKey: "nope", columnName: "Done", name: "Later" }), /Project with key "NOPE" does not exist!/);
      assert.equal(column.edit({ projectKey: "OTHER", columnName: "Done", name: "NEXT UP" }).name, "NEXT UP");

      db.run("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column written'); END");
      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: " NEXT UP " }), { ...todo, name: "NEXT UP" });
      db.run("DROP TRIGGER fail_column_update");

      assert.throws(() => column.create({ projectKey: "APP", name: "next up" }), /There is already a "next up" column/);
      assert.throws(() => column.create({ projectKey: "APP", name: " next up " }), /There is already a "next up" column/);
      assert.throws(() => column.create({ projectKey: "APP", name: " " }), /Column name cannot be blank/);
      assert.equal(column.create({ projectKey: "APP", name: " Later " }).name, "Later");
      assert.equal(column.edit({ projectKey: "APP", columnName: " later ", name: "Someday" }).name, "Someday");
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
