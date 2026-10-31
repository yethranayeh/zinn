import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, project, task } from "../index";
import { getDb } from "./db";
import { CoreError } from "./errors";
import { withStore } from "./testing";

test("column renames keep identity and tasks, reject duplicates, and skip no-op writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-columns-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const db = getDb({ createsDatabase: true });
      const app = project.create({ key: "APP", name: "App" }, actor);
      project.create({ key: "OTHER" }, actor);
      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      const todo = column.getAllByProjectKey("APP")[1];
      task.move({ taskKey: first.key, targetColumn: "todo" }, actor);

      const renamed = column.edit({ projectKey: "app", columnName: "todo", name: " Next up " }, actor).column;
      assert.deepEqual(renamed, { ...todo, name: "Next up" });
      assert.equal(task.getByKey(first.key).column_id, todo!.id);
      assert.deepEqual(column.getAllByProjectKey("APP").map(c => c.name), ["Backlog", "Next up", "In Progress", "Review", "Done"]);
      assert.equal(task.move({ taskKey: first.key, targetColumn: "NEXT UP" }, actor).column_id, todo!.id);

      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: "NEXT UP" }, actor).column, { ...todo, name: "NEXT UP" });
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: "done" }, actor), (error) => error instanceof CoreError && error.kind === "conflict" && error.facts.entity === "column" && error.facts.key === "done");
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "next up", name: " " }, actor), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.some((field) => ["name", "columnName"].includes(String(field))));
      assert.throws(() => column.edit({ projectKey: "APP", columnName: "missing", name: "Later" }, actor), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "column" && error.facts.key === "missing");
      assert.throws(() => column.edit({ projectKey: "nope", columnName: "Done", name: "Later" }, actor), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "project" && error.facts.key === "NOPE");
      assert.equal(column.edit({ projectKey: "OTHER", columnName: "Done", name: "NEXT UP" }, actor).column.name, "NEXT UP");

      db.exec("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column written'); END");
      assert.deepEqual(column.edit({ projectKey: "APP", columnName: "next up", name: " NEXT UP " }, actor).column, { ...todo, name: "NEXT UP" });
      db.exec("DROP TRIGGER fail_column_update");

      assert.throws(() => column.create({ projectKey: "APP", name: "next up" }, actor), (error) => error instanceof CoreError && error.kind === "conflict" && error.facts.entity === "column" && error.facts.key === "next up");
      assert.throws(() => column.create({ projectKey: "APP", name: " next up " }, actor), (error) => error instanceof CoreError && error.kind === "conflict" && error.facts.entity === "column" && error.facts.key === "next up");
      assert.throws(() => column.create({ projectKey: "APP", name: " " }, actor), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.some((field) => ["name", "columnName"].includes(String(field))));
      assert.equal(column.create({ projectKey: "APP", name: " Later " }, actor).name, "Later");
      assert.equal(column.edit({ projectKey: "APP", columnName: " later ", name: "Someday" }, actor).column.name, "Someday");
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("column orders move only the moved column and skip no-op writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-columns-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const db = getDb({ createsDatabase: true });
      project.create({ key: "APP", name: "App" }, actor);
      const names = () => column.getAllByProjectKey("APP").map(c => c.name);
      const order = (columnName: string, direction: Parameters<typeof column.order>[0]["direction"], targetColumnName?: string) =>
        column.order({ projectKey: "app", columnName, direction, ...(targetColumnName == null ? {} : { targetColumnName }) } as Parameters<typeof column.order>[0], actor);

      const review = column.getAllByProjectKey("APP")[3];
      const moved = order("review", "first");
      assert.equal(moved.changed, true);
      assert.deepEqual({ ...moved.column, column_order: review!.column_order }, review);
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
      const activityBeforeNoOps = db.query("SELECT * FROM activity ORDER BY id").all();
      db.exec("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column written'); END");
      const writesBeforeNoOps = db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count;
      for (const [columnName, direction, targetColumnName] of [
        ["Done", "first"], ["Done", "previous"], ["Backlog", "last"], ["Backlog", "next"],
        ["Review", "before", "In Progress"], ["In Progress", "after", "review"],
        ["Review", "before", "review"], ["Review", "after", "REVIEW"],
      ] as const) {
        const unchanged = order(columnName, direction, targetColumnName);
        assert.deepEqual(unchanged.column, rowsBeforeNoOps.find(row => row.id === unchanged.column.id));
        assert.equal(unchanged.changed, false);
      }
      assert.deepEqual(db.query("SELECT * FROM activity ORDER BY id").all(), activityBeforeNoOps);
      assert.equal(db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count, writesBeforeNoOps);
      db.exec("DROP TRIGGER fail_column_update");
      assert.deepEqual(column.getAllByProjectKey("APP"), rowsBeforeNoOps);

      assert.throws(() => order("missing", "first"), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "column" && error.facts.key === "missing");
      assert.throws(() => order("Review", "before", "missing"), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "column" && error.facts.key === "missing");
      assert.throws(() => column.order({ projectKey: "nope", columnName: "Done", direction: "first" }, actor), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "project" && error.facts.key === "NOPE");
      assert.throws(() => order(" ", "first"), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.some((field) => ["name", "columnName"].includes(String(field))));
      assert.deepEqual(column.getAllByProjectKey("APP"), rowsBeforeNoOps);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("column task counts cover each column in board order, with archived tasks in one total", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-columns-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP", name: "App" }, actor);
      const other = project.create({ key: "OTHER" }, actor);
      const counts = () => {
        const { columns, archivedTaskCount } = column.getTaskCountsByProjectKey("app");
        return { columns: columns.map(entry => [entry.column.name, entry.taskCount]), archivedTaskCount };
      };

      assert.deepEqual(counts(), {
        columns: [["Backlog", 0], ["TODO", 0], ["In Progress", 0], ["Review", 0], ["Done", 0]],
        archivedTaskCount: 0,
      });

      for (const title of ["One", "Two", "Three", "Four", "Five"]) {
        task.create({ project_id: app.id, title, description: null }, actor);
      }
      task.create({ project_id: other.id, title: "Elsewhere", description: null }, actor);
      task.move({ taskKey: "APP-2", targetColumn: "Done" }, actor);
      task.move({ taskKey: "APP-3", targetColumn: "Done" }, actor);
      task.move({ taskKey: "APP-4", targetColumn: "Review" }, actor);
      task.archive("APP-3", actor);
      task.archive("APP-5", actor);
      column.order({ projectKey: "APP", columnName: "Done", direction: "first" }, actor);

      assert.deepEqual(counts(), {
        columns: [["Done", 1], ["Backlog", 1], ["TODO", 0], ["In Progress", 0], ["Review", 1]],
        archivedTaskCount: 2,
      });
      assert.deepEqual(column.getTaskCountsByProjectKey("APP").columns.map(entry => entry.column), column.getAllByProjectKey("APP"));
      assert.throws(() => column.getTaskCountsByProjectKey("nope"), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "project" && error.facts.key === "NOPE");
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
