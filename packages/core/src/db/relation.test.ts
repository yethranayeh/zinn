import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runRelationCheck(script: string) {
  const testDir = mkdtempSync(join(tmpdir(), "zinn-relations-"));
  try {
    // Separate process keeps the DB singleton and environment isolated from other tests.
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, task, relation } from ${JSON.stringify(new URL("../../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("../db.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      ${script}
    `], { env: { ...process.env, ZINN_DIR: testDir } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

for (const inputOrder of ["smaller first", "larger first"]) {
  test(`related stores the smaller task ID as source with ${inputOrder}`, () => {
    runRelationCheck(`
      const app = project.create({ key: "APP" }, actor);
      const tasks = [1, 2].map(() => task.create({
        project_id: app.id, title: "Task", description: null,
      }, actor)).sort((a, b) => a.id < b.id ? -1 : 1);
      const [smaller, larger] = tasks;
      const source = ${JSON.stringify(inputOrder)} === "smaller first" ? smaller : larger;
      const target = source === smaller ? larger : smaller;
      const create = (source, target) => relation.create({
        sourceTaskKey: "APP-" + source.number,
        targetTaskKey: "APP-" + target.number,
        relation_type: "related",
      }, actor);
      const related = create(source, target);
      assert.equal(related.source_task_id, smaller.id);
      assert.equal(related.target_task_id, larger.id);
      assert.throws(() => create(source, target), /already exists/);
      assert.throws(() => create(target, source), /already exists/);
      assert.equal(relation.getAll("APP-1").length, 1);
      assert.equal(relation.getAll("APP-2")[0].id, related.id);
    `);
  });
}

test("dependency preserves the dependent task as source regardless of task ID order", () => {
  runRelationCheck(`
    const app = project.create({ key: "APP" }, actor);
    const tasks = [1, 2].map(() => task.create({
      project_id: app.id, title: "Task", description: null,
    }, actor)).sort((a, b) => a.id < b.id ? -1 : 1);
    for (const [dependent, prerequisite] of [tasks, [...tasks].reverse()]) {
      const dependency = relation.create({
        sourceTaskKey: "APP-" + dependent.number,
        targetTaskKey: "APP-" + prerequisite.number,
        relation_type: "dependency",
      }, actor);
      assert.equal(dependency.source_task_id, dependent.id);
      assert.equal(dependency.target_task_id, prerequisite.id);
    }
    // A symmetric connection between the same tasks is a separate relation.
    relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "related" }, actor);
    assert.equal(relation.getAll("APP-1").length, 3);
  `);
});

test("relations clean up without deleting connected tasks", () => {
  runRelationCheck(`
      const a = project.create({ key: "APP" }, actor);
      const b = project.create({ key: "OTHER" }, actor);
      for (let i = 0; i < 4; i++) {
        task.create({ project_id: a.id, title: "Task", description: null }, actor);
      }
      task.create({ project_id: b.id, title: "Survivor", description: null }, actor);
      const create = (sourceTaskKey, targetTaskKey, relation_type) =>
        relation.create({ sourceTaskKey, targetTaskKey, relation_type }, actor);
      const related = create("APP-2", "APP-1", "related");
      assert.ok(related.id);
      assert.ok(related.created_at > 0);
      assert.ok(related.source_task_id < related.target_task_id);
      assert.throws(() => create("APP-1", "APP-2", "related"), /already exists/);
      assert.throws(() => create("APP-1", "APP-1", "related"), /itself/);
      assert.equal(relation.getAll("APP-1")[0].id, related.id);
      assert.equal(relation.getAll("APP-2")[0].id, related.id);
      const dependency = create("APP-4", "APP-3", "dependency");
      assert.equal(dependency.source_task_id, task.getByKey("APP-4").id);
      assert.equal(dependency.target_task_id, task.getByKey("APP-3").id);
      const preserved = create("APP-3", "OTHER-1", "related");
      task.delete("APP-4", actor);
      assert.deepEqual(relation.getAll("APP-3").map(r => r.id), [preserved.id]);
      create("APP-3", "APP-2", "dependency");
      task.delete("APP-2", actor);
      assert.deepEqual(relation.getAll("APP-1"), []);
      assert.deepEqual(relation.getAll("APP-3").map(r => r.id), [preserved.id]);
      project.delete("APP", actor);
      assert.ok(task.getByKey("OTHER-1"));
      assert.deepEqual(relation.getAll("OTHER-1"), []);
      assert.deepEqual(getDb().query("PRAGMA foreign_key_check").all(), []);
  `);
});

test("duplicate direction and optional task enrichment preserve raw lookup", () => {
  runRelationCheck(`
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    task.create({ project_id: app.id, title: "Copy", description: null }, actor);
    task.create({ project_id: other.id, title: "Original", description: null }, actor);
    const before = task.getByKey("OTHER-1");
    const created = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "OTHER-1", relation_type: "duplicate" }, actor);
    assert.equal(created.source_task_id, task.getByKey("APP-1").id);
    assert.equal(created.target_task_id, before.id);
    assert.deepEqual(task.getByKey("OTHER-1"), before);
    assert.throws(() => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "OTHER-1", relation_type: "duplicate" }, actor), /already exists/);
    const raw = relation.getAll("APP-1");
    assert.equal("source" in raw[0], false);
    assert.deepEqual(relation.getAll("APP-1", { include: { tasks: false } }), raw);
    task.archive("OTHER-1", actor);
    const [expanded] = relation.getAll("APP-1", { include: { tasks: true } });
    assert.equal(expanded.source.key, "APP-1");
    assert.equal(expanded.target.key, "OTHER-1");
    assert.equal(expanded.target.title, "Original");
    assert.ok(expanded.target.archived_at);
    relation.create({ sourceTaskKey: "OTHER-1", targetTaskKey: "APP-1", relation_type: "duplicate" }, actor);
    assert.equal(relation.getAll("APP-1").length, 2);
  `);
});

test("relation deletion matches type and direction, preserving tasks and other relations", () => {
  runRelationCheck(`
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    task.create({ project_id: app.id, title: "Source", description: null }, actor);
    task.create({ project_id: other.id, title: "Target", description: null }, actor);
    task.archive("OTHER-1", actor);
    const before = [task.getByKey("APP-1"), task.getByKey("OTHER-1")];
    const input = { sourceTaskKey: "APP-1", targetTaskKey: "OTHER-1", relation_type: "related" };
    const reverse = { sourceTaskKey: "OTHER-1", targetTaskKey: "APP-1" };
    const related = relation.create(input, actor);
    for (const relation_type of ["dependency", "duplicate"]) {
      const forward = relation.create({ ...input, relation_type }, actor);
      assert.throws(() => relation.delete({ ...reverse, relation_type }, actor), /does not exist/);
      const backward = relation.create({ ...reverse, relation_type }, actor);
      assert.deepEqual(relation.delete({ ...input, relation_type }, actor), forward);
      assert.ok(relation.getAll("APP-1").some(r => r.id === backward.id));
    }
    assert.throws(() => relation.delete({ ...input, relation_type: "invalid" }, actor));
    assert.throws(() => relation.delete({ ...input, targetTaskKey: "OTHER-99" }, actor));
    assert.deepEqual(relation.delete({ ...input, ...reverse }, actor), related);
    assert.throws(() => relation.delete(input, actor), /does not exist/);
    assert.equal(relation.getAll("APP-1").length, 2);
    assert.deepEqual([task.getByKey("APP-1"), task.getByKey("OTHER-1")], before);
    assert.deepEqual(getDb().query("PRAGMA foreign_key_check").all(), []);
  `);
});

test("subtasks allow branching and nesting but reject multiple parents and cycles atomically", () => {
  runRelationCheck(`
    const app = project.create({ key: "APP" }, actor);
    for (let i = 0; i < 5; i++) {
      task.create({ project_id: app.id, title: "Task", description: null }, actor);
    }
    const input = (child, parent) => ({ sourceTaskKey: child, targetTaskKey: parent, relation_type: "subtask" });
    const create = (child, parent) => relation.create(input(child, parent), actor);
    create("APP-2", "APP-1");
    create("APP-3", "APP-1");
    create("APP-4", "APP-2");
    const activityCount = () => getDb().query("SELECT count(*) AS n FROM activity").get().n;
    const before = activityCount();
    assert.throws(() => create("APP-2", "APP-1"), /already exists/);
    assert.throws(() => create("APP-2", "APP-5"), /already has a parent/);
    assert.throws(() => create("APP-1", "APP-2"), /cycle/);
    assert.throws(() => create("APP-1", "APP-4"), /cycle/);
    assert.throws(() => create("APP-1", "APP-1"), /itself/);
    assert.equal(activityCount(), before);
    assert.equal(relation.getAll("APP-1").length, 2);
    // Other relation types do not participate in the hierarchy.
    relation.create({ ...input("APP-1", "APP-4"), relation_type: "dependency" }, actor);
    assert.throws(() => relation.delete(input("APP-1", "APP-2"), actor), /does not exist/);
    relation.delete(input("APP-2", "APP-1"), actor);
    create("APP-2", "APP-5");
    assert.equal(relation.getAll("APP-4").filter(r => r.relation_type === "subtask").length, 1);
  `);
});

test("subtask lifecycle preserves tasks and records activity on both sides", () => {
  runRelationCheck(`
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    task.create({ project_id: app.id, title: "Child", description: null }, actor);
    task.create({ project_id: other.id, title: "Parent", description: null }, actor);
    task.archive("OTHER-1", actor);
    const child = task.getByKey("APP-1");
    const parent = task.getByKey("OTHER-1");
    const input = { sourceTaskKey: child.key, targetTaskKey: parent.key, relation_type: "subtask" };
    relation.create(input, actor);
    assert.deepEqual(task.getByKey(child.key), child);
    assert.deepEqual(task.getByKey(parent.key), parent);
    const rows = getDb().query("SELECT entity_id, changes FROM activity WHERE action = 'relation_create'").all();
    assert.deepEqual(rows.map(r => r.entity_id).sort(), [child.id, parent.id].sort());
    assert.equal(JSON.parse(rows[0].changes).type, "subtask");
    relation.delete(input, actor);
    assert.equal(getDb().query("SELECT count(*) AS n FROM activity WHERE action = 'relation_delete'").get().n, 2);
    relation.create(input, actor);
    task.delete(parent.key, actor);
    assert.deepEqual(task.getByKey(child.key), child);
    assert.deepEqual(relation.getAll(child.key), []);
    assert.equal(getDb().query("SELECT count(*) AS n FROM activity WHERE action = 'relation_delete' AND entity_id = ?").get(child.id).n, 2);
    assert.deepEqual(getDb().query("PRAGMA foreign_key_check").all(), []);
  `);
});
