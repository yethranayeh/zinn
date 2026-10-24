import { spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { activity, comment, CoreError, label, project, relation, task } from "../index";
import { getDb } from "./db";
import * as dbTask from "./db/task";
import { withTestStore } from "./testing";

const actor = { name: "Test", email: null, kind: "human" as const };

function seed() {
  const app = project.create({ key: "APP" }, actor);
  const other = project.create({ key: "OTHER" }, actor);
  label.create({ name: "bug" }, actor);
  const first = task.create({ project_id: app.id, title: "First", labelNames: ["bug"] }, actor);
  const second = task.create({ project_id: other.id, title: "Second" }, actor);
  const survivor = task.create({ project_id: app.id, title: "Survivor" }, actor);
  comment.create({ taskKey: first.key, text: "Searchable comment" }, actor);
  relation.create({ sourceTaskKey: first.key, targetTaskKey: second.key, relation_type: "dependency" }, actor);
  relation.create({ sourceTaskKey: first.key, targetTaskKey: survivor.key, relation_type: "related" }, actor);
  relation.create({ sourceTaskKey: second.key, targetTaskKey: survivor.key, relation_type: "subtask" }, actor);
  task.archive(second.key, actor);
  return { first: task.getByKey(first.key), second: task.getByKey(second.key), survivor };
}

function snapshot() {
  return Object.fromEntries([
    "task", "task_relations", "task_label", "comment", "label", "activity", "task_search",
  ].map(table => [table, getDb().query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("bulk task deletion preserves single-delete results and history across projects and archived tasks", () => {
  withTestStore(() => {
    const { first, second, survivor } = seed();
    const beforeIds = new Set(activity.getAll().map(event => event.id));
    assert.deepEqual(task.deleteMany(["app-1", second.key], actor), [first, second]);
    assert.deepEqual(task.getAll({ archive: "all" }), [survivor]);
    assert.deepEqual(relation.getAll(survivor.key), []);
    assert.equal(getDb().query<{ count: number }>("SELECT COUNT(*) AS count FROM comment").get()!.count, 0);
    assert.equal(getDb().query<{ count: number }>("SELECT COUNT(*) AS count FROM task_label").get()!.count, 0);
    assert.equal(label.getAll().length, 1);
    assert.deepEqual(getDb().query<{ task_id: string }>("SELECT task_id FROM task_search").all(), [{ task_id: survivor.id }]);

    const events = activity.getAll().filter(event => !beforeIds.has(event.id)).reverse();
    assert.deepEqual(events.map(event => [event.entity_id, event.action]), [
      [second.id, "relation_delete"],
      [survivor.id, "relation_delete"],
      [first.id, "delete"],
      [survivor.id, "relation_delete"],
      [second.id, "delete"],
    ]);
    assert.deepEqual(events.filter(event => event.action === "delete").map(event => event.changes), [
      { key: first.key, title: first.title },
      { key: second.key, title: second.title },
    ]);
    assert.deepEqual(events[0]!.changes, {
      type: "dependency",
      source: { id: first.id, key: first.key },
      target: { id: second.id, key: second.key },
    });
  });
});

test("bulk task deletion refuses unknown and repeated keys without changing stored data", () => {
  withTestStore(() => {
    const { first, second } = seed();
    const before = snapshot();
    for (const keys of [[first.key, "APP-99"], [first.key, "invalid-key"], [first.key, first.key], [first.key.toLowerCase(), first.key], []]) {
      assert.throws(() => task.deleteMany(keys, actor), CoreError);
      assert.deepEqual(snapshot(), before);
    }
    const writesBefore = getDb().query<{ count: number }>("SELECT total_changes() AS count").get()!.count;
    assert.throws(() => task.deleteMany([first.key, second.key, "app-1"], actor), error =>
      error instanceof CoreError && error.kind === "input" && error.message.includes(first.key));
    assert.equal(getDb().query<{ count: number }>("SELECT total_changes() AS count").get()!.count, writesBefore);
  });
});

test("a failure during a later deletion rolls back tasks, relations, search, attachments and history", () => {
  withTestStore(() => {
    const { first, second } = seed();
    const before = snapshot();
    const deleteById = dbTask.deleteById;
    const failure = new Error("delete failed");
    let calls = 0;
    const mocked = spyOn(dbTask, "deleteById").mockImplementation(id => {
      calls++;
      if (calls === 2) {
        throw failure;
      }
      return deleteById(id);
    });
    try {
      assert.throws(() => task.deleteMany([first.key, second.key], actor), error => error === failure);
      assert.equal(calls, 2);
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(task.search({ query: "Searchable" }).tasks.map(entry => entry.key), [first.key]);
    } finally {
      mocked.mockRestore();
    }
  });
});
