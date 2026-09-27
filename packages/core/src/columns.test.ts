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
      const app = project.create({ key: "APP", name: "App" }, actor);
      project.create({ key: "OTHER" }, actor);
      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      const todo = column.getAllByProjectKey("APP")[1];
      task.move({ taskKey: first.key, targetColumn: "todo" }, actor);

      const renamed = column.edit({ projectKey: "app", columnName: "todo", name: " Next up " }, actor);
      assert.deepEqual(renamed, { ...todo, name: "Next up" });
      assert.equal(task.getByKey(first.key).column_id, todo.id);
      assert.deepEqual(column.getAllByProjectKey("APP").map(c => c.name), ["Backlog", "Next up", "In Progress", "Review", "Done"]);
      assert.equal(task.move({ taskKey: first.key, targetColumn: "NEXT UP" }, actor).column_id, todo.id);

      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: "NEXT UP" }, actor), { ...todo, name: "NEXT UP" });
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: "done" }, actor), /There is already a "done" column/);
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: " " }, actor), /Column name cannot be blank/);
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "missing", name: "Later" }, actor), /App does not have a column named "missing"/);
      assert.throws(() => column.edit({ projectKey: "nope", columnName: "Done", name: "Later" }, actor), /Project with key "NOPE" does not exist!/);
      assert.equal(column.edit({ projectKey: "OTHER", columnName: "Done", name: "NEXT UP" }, actor).name, "NEXT UP");

      db.run("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column written'); END");
      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: " NEXT UP " }, actor), { ...todo, name: "NEXT UP" });
      db.run("DROP TRIGGER fail_column_update");

      assert.throws(() => column.create({ projectKey: "APP", name: "next up" }, actor), /There is already a "next up" column/);
      assert.throws(() => column.create({ projectKey: "APP", name: " next up " }, actor), /There is already a "next up" column/);
      assert.throws(() => column.create({ projectKey: "APP", name: " " }, actor), /Column name cannot be blank/);
      assert.equal(column.create({ projectKey: "APP", name: " Later " }, actor).name, "Later");
      assert.equal(column.edit({ projectKey: "APP", columnName: " later ", name: "Someday" }, actor).name, "Someday");
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("column orders move only the moved column and skip no-op writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-columns-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const db = getDb();
      project.create({ key: "APP", name: "App" }, actor);
      const names = () => column.getAllByProjectKey("APP").map(c => c.name);
      const order = (columnName, direction, targetColumnName) =>
        column.order({ projectKey: "app", columnName, direction, ...(targetColumnName == null ? {} : { targetColumnName }) }, actor);

      const review = column.getAllByProjectKey("APP")[3];
      const moved = order("review", "first");
      assert.deepEqual({ ...moved, column_order: review.column_order }, review);
      assert.deepEqual(names(), ["Review", "Backlog", "TODO", "In Progress", "Done"]);
      order("REVIEW", "next");
      assert.deepEqual(names(), ["Backlog", "Review", "TODO", "In Progress", "Done"]);
      order("Review", "previous");
      assert.deepEqual(names(), ["Review", "Backlog", "TODO", "In Progress", "Done"]);
      order("Review", "last");
      assert.deepEqual(names(), ["Backlog", "TODO", "In Progress", "Done", "Review"]);

      const rowsBefore = column.getAllByProjectKey("APP");
      order("backlog", "before", "DONE");
      assert.deepEqual(names(), ["TODO", "In Progress", "Backlog", "Done", "Review"]);
      const changedRows = column.getAllByProjectKey("APP").filter(row => !rowsBefore.some(before => JSON.stringify(before) === JSON.stringify(row)));
      assert.deepEqual(changedRows.map(row => row.name), ["Backlog"]);
      order("Review", "after", "todo");
      assert.deepEqual(names(), ["TODO", "Review", "In Progress", "Backlog", "Done"]);
      order("TODO", "after", "in progress");
      assert.deepEqual(names(), ["Review", "In Progress", "TODO", "Backlog", "Done"]);
      order("Done", "before", "Review");
      assert.deepEqual(names(), ["Done", "Review", "In Progress", "TODO", "Backlog"]);

      const rowsBeforeNoOps = column.getAllByProjectKey("APP");
      db.run("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column written'); END");
      for (const [columnName, direction, targetColumnName] of [
        ["Done", "first"], ["Done", "previous"], ["Backlog", "last"], ["Backlog", "next"],
        ["Review", "before", "In Progress"], ["In Progress", "after", "review"],
        ["Review", "before", "review"], ["Review", "after", "REVIEW"],
      ]) {
        const unchanged = order(columnName, direction, targetColumnName);
        assert.deepEqual(unchanged, rowsBeforeNoOps.find(row => row.id === unchanged.id));
      }
      db.run("DROP TRIGGER fail_column_update");
      assert.deepEqual(column.getAllByProjectKey("APP"), rowsBeforeNoOps);

      assert.throws(() => order("missing", "first"), /App does not have a column named "missing"/);
      assert.throws(() => order("Review", "before", "missing"), /App does not have a column named "missing"/);
      assert.throws(() => column.order({ projectKey: "nope", columnName: "Done", direction: "first" }, actor), /Project with key "NOPE" does not exist!/);
      assert.throws(() => order(" ", "first"), /Column name cannot be blank/);
      assert.deepEqual(column.getAllByProjectKey("APP"), rowsBeforeNoOps);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
