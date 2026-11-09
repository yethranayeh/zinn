import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { activity, column, CoreError, project, task } from "../index";
import { getDb } from "./db";
import { snapshot } from "./migrations/testing";
import { withTestStore } from "./testing";

const actor = { name: "Test", email: null, kind: "human" as const };

test("column deletion preserves task history and records project-scoped activity", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const first = task.create({ project_id: app.id, title: "First" }, actor);
    const original = column.getByName("app", " backlog ");
    task.move({ taskKey: first.key, targetColumn: "TODO" }, actor);
    const history = activity.getAll({ taskKey: first.key }).events;
    const eventsBefore = new Set(activity.getAll().events.map((event) => event.id));

    assert.deepEqual(column.delete({ projectKey: "app", columnName: " BACKLOG " }, actor), original);
    assert.equal(column.getById(original.id), null);
    assert.deepEqual(activity.getAll({ taskKey: first.key }).events, history);
    const events = activity.getAll().events.filter((event) => !eventsBefore.has(event.id));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      ...events[0], entity_type: "column", entity_id: original.id, action: "delete",
      changes: { project: { id: app.id, key: "APP" }, name: "Backlog" },
    });
    assert.ok(activity.getAll({ projectKey: "APP" }).events.some((event) => event.id === events[0]!.id));
    assert.deepEqual(getDb().query("PRAGMA foreign_key_check").all(), []);
  });
});

test("column deletion refuses active, mixed and archived tasks without changing the database", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    task.create({ project_id: app.id, title: "First" }, actor);
    task.create({ project_id: app.id, title: "Second" }, actor);
    const refuses = (active: number, archived: number) => {
      const before = snapshot(getDb());
      assert.throws(() => column.delete({ projectKey: "APP", columnName: "backlog" }, actor),
        (error) => error instanceof CoreError && error.kind === "conflict" &&
          error.facts.reason === "has_tasks" && error.facts.entity === "column" &&
          error.message.includes(`${active} active`) && error.message.includes(`${archived} archived`));
      assert.deepEqual(snapshot(getDb()), before);
    };
    refuses(2, 0);
    task.archive("APP-1", actor);
    refuses(1, 1);
    task.archive("APP-2", actor);
    refuses(0, 2);
    for (const entry of column.getAllByProjectKey("APP").slice(1)) {
      column.delete({ projectKey: "APP", columnName: entry.name }, actor);
    }
    refuses(0, 2);
  });
});

test("column deletion permits no columns and task creation rolls back numbering until recovery", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    column.delete({ projectKey: "APP", columnName: "Backlog" }, actor);
    const first = task.create({ project_id: app.id, title: "First" }, actor);
    assert.equal(first.column_id, column.getByName("APP", "TODO").id);
    task.delete(first.key, actor);
    for (const entry of column.getAllByProjectKey("APP")) {
      column.delete({ projectKey: "APP", columnName: entry.name }, actor);
    }
    assert.deepEqual(column.getTaskCountsByProjectKey("APP"), { columns: [], archivedTaskCount: 0 });
    const before = snapshot(getDb());
    for (const columnName of [undefined, "Backlog"]) {
      assert.throws(() => task.create({ project_id: app.id, title: "Refused", columnName }, actor),
        (error) => error instanceof CoreError && error.facts.reason === "no_columns" &&
          !error.message.includes("zinn"));
      assert.deepEqual(snapshot(getDb()), before);
    }
    column.create({ projectKey: "APP", name: "Recovered", category: "todo" }, actor);
    assert.equal(task.create({ project_id: app.id, title: "Recovered" }, actor).key, "APP-2");
  });
});

test("column deletion validates entities and rolls back when activity cannot be recorded", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    const before = snapshot(getDb());
    for (const [projectKey, columnName, entity, key] of [
      ["missing", "Done", "project", "MISSING"],
      ["APP", "Missing", "column", "Missing"],
    ]) {
      assert.throws(() => column.delete({ projectKey: projectKey!, columnName: columnName! }, actor),
        (error) => error instanceof CoreError && error.kind === "missing" &&
          error.facts.entity === entity && error.facts.key === key);
      assert.deepEqual(snapshot(getDb()), before);
    }
    getDb().exec("CREATE TRIGGER refuse_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'activity refused'); END");
    const beforeFailure = snapshot(getDb());
    assert.throws(() => column.delete({ projectKey: "APP", columnName: "Done" }, actor));
    assert.deepEqual(snapshot(getDb()), beforeFailure);
  });
});
