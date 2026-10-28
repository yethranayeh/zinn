import { spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { activity, project, relation, task } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { relationTypeSchema } from "./schemas/relation";
import { withTestStore } from "./testing";

const human = { name: "Test", email: null, kind: "human" as const };
const actor = {
  name: "Agent", email: "agent@example.com", kind: "agent" as const,
  source: "test", sessionId: "session", threadId: "thread", agent: "worker",
  model: "test-model", effort: "high",
};

for (const relationType of relationTypeSchema.options) {
  for (const deletedIsSource of [false, true]) {
    test(`project deletion records surviving ${relationType} endpoints with deleted source=${deletedIsSource}`, () => {
      withTestStore(() => {
        const removed = project.create({ key: "REMOVED" }, human);
        const kept = project.create({ key: "KEPT" }, human);
        const other = project.create({ key: "OTHER" }, human);
        const expected: Array<{ taskId: string; changes: unknown }> = [];
        const deletedIds: Array<string> = [];
        for (const deletedArchived of [false, true]) {
          for (const survivorArchived of [false, true]) {
            const deleted = task.create({ project_id: removed.id, title: "Deleted" }, human);
            const survivor = task.create({ project_id: survivorArchived ? other.id : kept.id, title: "Survivor" }, human);
            const source = deletedIsSource ? deleted : survivor;
            const target = deletedIsSource ? survivor : deleted;
            relation.create({ sourceTaskKey: source.key, targetTaskKey: target.key, relation_type: relationType }, human);
            if (deletedArchived) {
              task.archive(deleted.key, human);
            }
            if (survivorArchived) {
              task.archive(survivor.key, human);
            }
            expected.push({ taskId: survivor.id, changes: task.activity(survivor.key).find(event => event.action === "relation_create")!.changes });
            deletedIds.push(deleted.id);

            const extra = task.create({ project_id: removed.id, title: "Also deleted" }, human);
            relation.create({ sourceTaskKey: extra.key, targetTaskKey: survivor.key, relation_type: "related" }, human);
            expected.push({ taskId: survivor.id, changes: task.activity(survivor.key).at(-1)!.changes });
            deletedIds.push(extra.id);
          }
        }
        const internalSource = task.create({ project_id: removed.id, title: "Internal source" }, human);
        const internalTarget = task.create({ project_id: removed.id, title: "Internal target" }, human);
        relation.create({ sourceTaskKey: internalSource.key, targetTaskKey: internalTarget.key, relation_type: relationType }, human);
        deletedIds.push(internalSource.id, internalTarget.id);
        const untouchedSource = task.create({ project_id: kept.id, title: "Untouched source" }, human);
        const untouchedTarget = task.create({ project_id: other.id, title: "Untouched target" }, human);
        const untouchedRelation = relation.create({ sourceTaskKey: untouchedSource.key, targetTaskKey: untouchedTarget.key, relation_type: relationType }, human);
        const beforeTasks = task.getAll({ archive: "all" }).filter(item => item.project_id !== removed.id);
        const beforeIds = new Set(activity.getAll().events.map(event => event.id));

        project.delete(removed.key, actor);

        const events = activity.getAll().events.filter(event => !beforeIds.has(event.id));
        const aggregate = events.filter(event => event.entity_type === "project");
        assert.equal(aggregate.length, 1);
        assert.equal(aggregate[0]!.action, "delete");
        const survivorEvents = events.filter(event => event.entity_type === "task");
        assert.equal(survivorEvents.length, expected.length);
        for (const entry of expected) {
          const matching = survivorEvents.filter(event => event.entity_id === entry.taskId && JSON.stringify(event.changes) === JSON.stringify(entry.changes));
          assert.equal(matching.length, 1);
          const event = matching[0]!;
          assert.equal(event.action, "relation_delete");
          assert.equal(event.created_at, aggregate[0]!.created_at);
          for (const field of Object.keys(event).filter(field => field.startsWith("actor_"))) {
            assert.equal(event[field as keyof typeof event], aggregate[0]![field as keyof typeof event]);
          }
          assert.equal(event.actor_session_id, actor.sessionId);
        }
        assert.equal(events.some(event => deletedIds.includes(event.entity_id)), false);
        assert.deepEqual(task.getAll({ archive: "all" }), beforeTasks);
        assert.deepEqual(relation.getAll(untouchedSource.key), [untouchedRelation]);
        for (const survivor of beforeTasks.filter(item => item.id !== untouchedSource.id && item.id !== untouchedTarget.id)) {
          assert.deepEqual(relation.getAll(survivor.key), []);
        }
      });
    });
  }
}

test("project deletion rolls back survivor activity, cascades and search on failure", () => {
  for (const failureStage of ["activity", "delete"] as const) {
    withTestStore(() => {
      const removed = project.create({ key: "REMOVED" }, human);
      const kept = project.create({ key: "KEPT" }, human);
      const deleted = task.create({ project_id: removed.id, title: "Searchable" }, human);
      for (const title of ["First", "Second"]) {
        const survivor = task.create({ project_id: kept.id, title }, human);
        relation.create({ sourceTaskKey: deleted.key, targetTaskKey: survivor.key, relation_type: "dependency" }, human);
      }
      const snapshot = () => Object.fromEntries([
        "project", "project_column", "task", "task_relations", "activity", "task_search",
      ].map(table => [table, getDb().query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const before = snapshot();
      const createActivity = dbActivity.create;
      const failure = new Error("recording failed");
      let survivorRecords = 0;
      const recording = spyOn(dbActivity, "create").mockImplementation(input => {
        if (input.action === "relation_delete") {
          survivorRecords++;
          if (failureStage === "activity" && survivorRecords === 2) {
            throw failure;
          }
        }
        return createActivity(input);
      });
      if (failureStage === "delete") {
        getDb().exec("CREATE TRIGGER reject_delete BEFORE DELETE ON project BEGIN SELECT RAISE(ABORT, 'delete failed'); END");
      }
      try {
        assert.throws(() => project.delete(removed.key, actor), error => failureStage === "activity"
          ? error === failure
          : error instanceof Error && error.message.includes("delete failed"));
        assert.equal(survivorRecords, 2);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(task.search({ query: "Searchable" }).tasks.map(item => item.key), [deleted.key]);
      } finally {
        recording.mockRestore();
      }
    });
  }
});

test("project deletion advances survivor activity sorting without changing task timestamps or board order", () => {
  withTestStore(() => {
    let now = Date.UTC(2026, 0, 1);
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const removed = project.create({ key: "REMOVED" }, human);
      const kept = project.create({ key: "KEPT" }, human);
      const deleted = task.create({ project_id: removed.id, title: "Deleted" }, human);
      const survivor = task.create({ project_id: kept.id, title: "Survivor" }, human);
      relation.create({ sourceTaskKey: deleted.key, targetTaskKey: survivor.key, relation_type: "dependency" }, human);
      now++;
      const recent = task.create({ project_id: kept.id, title: "Recent" }, human);
      const list = (sort?: "activity") => task.getAll({ projectKey: kept.key, sort }).map(item => item.key);
      assert.deepEqual(list("activity"), [recent.key, survivor.key]);
      now++;
      project.delete(removed.key, actor);
      assert.deepEqual(list("activity"), [survivor.key, recent.key]);
      assert.deepEqual(list(), [survivor.key, recent.key]);
      assert.equal(task.getByKey(survivor.key).updated_at, survivor.updated_at);
    } finally {
      clock.mockRestore();
    }
  });
});
