import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { CoreError, project, relation, relationTypeSchema, task } from "../index";
import { getDb } from "./db";
import * as dbRelation from "./db/relation";
import { withTestStore } from "./testing";

const actor = { name: "Test Human", email: null, kind: "human" as const };

function seed() {
  const app = project.create({ key: "APP" }, actor);
  const other = project.create({ key: "OTHER" }, actor);
  for (let index = 0; index < 4; index++) {
    task.create({ project_id: app.id, title: `Task ${index}` }, actor);
  }
  task.create({ project_id: other.id, title: "Archived task" }, actor);
  task.archive("OTHER-1", actor);
  return app;
}

function snapshot() {
  return Object.fromEntries(["project", "task", "task_relations", "activity", "task_search"].map((table) =>
    [table, getDb().query(`SELECT * FROM ${table} ORDER BY rowid`).all()],
  ));
}

function isConflict(reason: string) {
  return (error: unknown) => error instanceof CoreError && error.kind === "conflict" && error.facts.reason === reason;
}

for (const originalType of relationTypeSchema.options) {
  for (const requestedType of relationTypeSchema.options) {
    for (const reversed of [false, true]) {
      test(`ZINN-91: ${originalType} to ${requestedType}, reversed=${reversed}, requires deliberate replacement`, () => {
        withTestStore(() => {
          seed();
          const original = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "OTHER-1", relation_type: originalType }, actor);
          const input = {
            sourceTaskKey: reversed ? "OTHER-1" : "APP-1",
            targetTaskKey: reversed ? "APP-1" : "OTHER-1",
            relation_type: requestedType,
          };
          const before = snapshot();
          const exact = originalType === requestedType && (!reversed || originalType === "related");
          if (exact) {
            assert.throws(() => relation.getConflicts(input), isConflict("already_exists"));
            assert.throws(() => relation.create({ ...input, replace: true }, actor), isConflict("already_exists"));
            assert.deepEqual(snapshot(), before);
            return;
          }

          const conflicts = relation.getConflicts(input);
          assert.deepEqual(conflicts.map((entry) => entry.id), [original.id]);
          assert.equal(conflicts[0]!.source.id, original.source_task_id);
          assert.equal(conflicts[0]!.target.id, original.target_task_id);
          assert.throws(() => relation.create(input, actor), (error) => error instanceof CoreError && error.kind === "conflict");
          assert.throws(() => relation.create({ ...input, replace: false }, actor), (error) => error instanceof CoreError && error.kind === "conflict");
          assert.deepEqual(snapshot(), before);

          const created = relation.create({ ...input, replace: [original.id] }, actor);
          assert.notEqual(created.id, original.id);
          assert.equal(created.relation_type, requestedType);
          if (requestedType === "related") {
            assert.ok(created.source_task_id < created.target_task_id);
          } else {
            assert.equal(created.source_task_id, task.getByKey(input.sourceTaskKey).id);
            assert.equal(created.target_task_id, task.getByKey(input.targetTaskKey).id);
          }
          assert.deepEqual(relation.getAll("APP-1"), [created]);
          assert.deepEqual(snapshot().task, before.task);
          const events = getDb().query<{ action: string; entity_id: string; created_at: number }>(
            "SELECT action, entity_id, created_at FROM activity ORDER BY id DESC LIMIT 4",
          ).all().reverse();
          assert.deepEqual(events.map((entry) => entry.action), ["relation_delete", "relation_delete", "relation_create", "relation_create"]);
          assert.deepEqual(new Set(events.map((entry) => entry.entity_id)), new Set([created.source_task_id, created.target_task_id]));
          assert.deepEqual(new Set(events.map((entry) => entry.created_at)), new Set([created.created_at]));
        });
      });
    }
  }
}

test("replacement combines a previous parent and an existing new-parent link without touching other links", () => {
  withTestStore(() => {
    seed();
    const previous = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor);
    const related = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, actor);
    const unrelated = relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-3", relation_type: "related" }, actor);
    const input = { sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "subtask" as const };
    assert.deepEqual(new Set(relation.getConflicts(input).map((entry) => entry.id)), new Set([previous.id, related.id]));
    const before = snapshot();
    const created = relation.create({ ...input, replace: [related.id, previous.id] }, actor);
    assert.deepEqual(relation.getAll("APP-1"), [created]);
    assert.deepEqual(relation.getAll("APP-2"), [unrelated]);
    assert.deepEqual(snapshot().task, before.task);
    const events = getDb().query<{ action: string; created_at: number }>("SELECT action, created_at FROM activity ORDER BY id DESC LIMIT 6").all();
    assert.equal(events.filter((entry) => entry.action === "relation_delete").length, 4);
    assert.equal(events.filter((entry) => entry.action === "relation_create").length, 2);
    assert.deepEqual(new Set(events.map((entry) => entry.created_at)), new Set([created.created_at]));
  });
});

test("reversing a subtask checks ancestry after excluding both replaced parent links", () => {
  withTestStore(() => {
    seed();
    relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor);
    relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-3", relation_type: "subtask" }, actor);
    const input = { sourceTaskKey: "APP-2", targetTaskKey: "APP-1", relation_type: "subtask" as const };
    const conflicts = relation.getConflicts(input);
    assert.equal(conflicts.length, 2);
    const created = relation.create({ ...input, replace: conflicts.map((entry) => entry.id) }, actor);
    assert.deepEqual(relation.getAll("APP-2"), [created]);
    assert.deepEqual(relation.getAll("APP-3"), []);
  });
});

test("a real subtask cycle and a self-relation preserve all links and activity even with replacement authorized", () => {
  withTestStore(() => {
    seed();
    relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor);
    relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-3", relation_type: "subtask" }, actor);
    relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "APP-1", relation_type: "related" }, actor);
    const before = snapshot();
    const input = { sourceTaskKey: "APP-3", targetTaskKey: "APP-1", relation_type: "subtask" as const };
    assert.throws(() => relation.getConflicts(input), isConflict("cycle"));
    assert.throws(() => relation.create({ ...input, replace: true }, actor), isConflict("cycle"));
    assert.throws(() => relation.create({ ...input, targetTaskKey: "app-3", replace: true }, actor),
      (error) => error instanceof CoreError && error.kind === "input");
    assert.deepEqual(snapshot(), before);
  });
});

for (const change of ["removed", "replaced", "already achieved", "another conflict added", "parent changed"] as const) {
  test(`stale replacement authorization refuses when the confirmed conflict was ${change}`, () => {
    withTestStore(() => {
      seed();
      const oldInput = { sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "related" as const };
      const original = relation.create(oldInput, actor);
      const input = { ...oldInput, relation_type: "subtask" as const };
      let expectedIds = relation.getConflicts(input).map((entry) => entry.id);
      if (change === "removed") {
        relation.delete(oldInput, actor);
      } else if (change === "replaced" || change === "already achieved") {
        relation.create({ ...oldInput, relation_type: change === "replaced" ? "dependency" : "subtask", replace: true }, actor);
      } else if (change === "another conflict added") {
        dbRelation.create({ source_task_id: original.source_task_id, target_task_id: original.target_task_id, relation_type: "dependency" });
      } else {
        relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "subtask" }, actor);
        expectedIds = relation.getConflicts(input).map((entry) => entry.id);
        relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-4", relation_type: "subtask", replace: true }, actor);
      }
      const before = snapshot();
      assert.throws(() => relation.create({ ...input, replace: expectedIds }, actor), isConflict("relation_changed"));
      assert.deepEqual(snapshot(), before);
    });
  });
}

test("replacement consumes historical overlaps only when authorized and keeps other pairs", () => {
  withTestStore(() => {
    seed();
    const related = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "related" }, actor);
    dbRelation.create({ source_task_id: related.source_task_id, target_task_id: related.target_task_id, relation_type: "dependency" });
    dbRelation.create({ source_task_id: related.target_task_id, target_task_id: related.source_task_id, relation_type: "duplicate" });
    const untouched = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, actor);
    const input = { sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" as const };
    assert.equal(relation.getAll("APP-1").length, 4);
    assert.equal(relation.getConflicts(input).length, 3);
    const created = relation.create({ ...input, replace: true }, actor);
    assert.deepEqual(relation.getAll("APP-1").map((entry) => entry.id), [untouched.id, created.id]);
    assert.deepEqual(getDb().query("PRAGMA foreign_key_check").all(), []);
  });
});

test("a late activity failure rolls replacement back together with its deletion events", () => {
  withTestStore(() => {
    seed();
    relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "related" }, actor);
    getDb().exec(`CREATE TRIGGER fail_relation_activity BEFORE INSERT ON activity
      WHEN NEW.action = 'relation_create' BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END`);
    const before = snapshot();
    assert.throws(() => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "dependency", replace: true }, actor));
    assert.deepEqual(snapshot(), before);
  });
});

test("task creation rejects conflicting types for one resolved target without using a task number", () => {
  withTestStore(() => {
    const app = seed();
    const before = snapshot();
    for (const firstType of relationTypeSchema.options) {
      for (const secondType of relationTypeSchema.options) {
        if (firstType === secondType) {
          continue;
        }
        assert.throws(() => task.create({ project_id: app.id, title: "Conflicting", relations: [
          { relation_type: "related", targetTaskKey: "APP-2" },
          { relation_type: firstType, targetTaskKey: "APP-1" },
          { relation_type: secondType, targetTaskKey: "app-1" },
        ] }, actor), (error) => error instanceof CoreError && error.kind === "input" && error.facts.key === "APP-1");
        assert.deepEqual(snapshot(), before);
      }
    }
    assert.equal(task.create({ project_id: app.id, title: "Next" }, actor).key, "APP-5");
  });
});
