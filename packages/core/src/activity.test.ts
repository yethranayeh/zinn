import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runActivityCheck(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-activity-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, task, relation, label } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import * as dbActivity from ${JSON.stringify(new URL("./db/activity.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const human = { name: "Test Human", email: "human@example.com", kind: "human" };
      const agent = { name: "claude-code", email: null, kind: "agent" };
      const app = project.create({ key: "APP" });
      const actions = (key) => task.activity(key).map((row) => row.action);
      ${script}
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("each task mutation records one row with its actor and changes", () => {
  runActivityCheck(`
    label.create({ name: "bug" });
    label.create({ name: "docs" });
    const created = task.create({ project_id: app.id, title: "First", description: "old", labelNames: ["bug"] }, human);
    const [createRow] = task.activity("APP-1");
    assert.equal(createRow.action, "create");
    assert.equal(createRow.entity_type, "task");
    assert.equal(createRow.entity_id, created.id);
    assert.equal(createRow.actor_name, "Test Human");
    assert.equal(createRow.actor_email, "human@example.com");
    assert.equal(createRow.actor_kind, "human");
    assert.equal(createRow.created_at, created.updated_at);
    assert.equal(createRow.changes.title, "First");
    assert.equal(createRow.changes.column.name, "Backlog");
    assert.deepEqual(createRow.changes.labels, ["bug"]);

    const edited = task.edit({ taskKey: "APP-1", title: "Renamed", description: "new", priority: "high", addLabelNames: ["docs"], removeLabelNames: ["bug"] }, agent);
    const editRow = task.activity("APP-1").at(-1);
    assert.equal(editRow.action, "edit");
    assert.equal(editRow.actor_kind, "agent");
    assert.equal(editRow.actor_email, null);
    assert.equal(editRow.created_at, edited.updated_at);
    assert.deepEqual(editRow.changes, {
      title: ["First", "Renamed"],
      description: ["old", "new"],
      priority: [null, "high"],
      labels: { added: ["docs"], removed: ["bug"] },
    });

    task.edit({ taskKey: "APP-1", priority: null }, agent);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, { priority: ["high", null] });
    task.label.add({ taskKey: "APP-1", labelNames: ["bug"] }, agent);
    assert.deepEqual(task.activity("APP-1").at(-1).changes, { labels: { added: ["bug"], removed: [] } });

    const moved = task.move({ taskKey: "APP-1", targetColumn: "in progress" }, agent);
    const moveRow = task.activity("APP-1").at(-1);
    assert.equal(moveRow.created_at, moved.updated_at);
    assert.deepEqual(moveRow.changes.column.map((column) => column.name), ["Backlog", "In Progress"]);
    assert.equal(moveRow.changes.column[1].id, moved.column_id);

    task.create({ project_id: app.id, title: "Second", description: null }, human);
    task.move({ taskKey: "APP-2", targetColumn: "In Progress" }, human);
    task.order({ taskKey: "APP-2", direction: "top" }, human);
    assert.equal(task.activity("APP-2").at(-1).action, "order");
    assert.equal(task.activity("APP-2").at(-1).changes, null);

    task.archive("APP-1", human);
    task.unarchive("APP-1", human);
    assert.deepEqual(actions("APP-1"), ["create", "edit", "edit", "edit", "move", "archive", "unarchive"]);
  `);
});

test("no-op mutations record nothing", () => {
  runActivityCheck(`
    label.create({ name: "bug" });
    label.create({ name: "docs" });
    task.create({ project_id: app.id, title: "Only", description: null, labelNames: ["bug"] }, human);
    task.edit({ taskKey: "APP-1", title: "Only" }, human);
    task.label.add({ taskKey: "APP-1", labelNames: ["bug"] }, human);
    task.label.remove({ taskKey: "APP-1", labelNames: ["docs"] }, human);
    task.move({ taskKey: "APP-1", targetColumn: "Backlog" }, human);
    task.order({ taskKey: "APP-1", direction: "top" }, human);
    task.unarchive("APP-1", human);
    task.archive("APP-1", human);
    task.archive("APP-1", human);
    assert.deepEqual(actions("APP-1"), ["create", "archive"]);
  `);
});

test("failed mutations leave no activity behind", () => {
  runActivityCheck(`
    task.create({ project_id: app.id, title: "Only", description: null }, human);
    const db = getDb();
    db.run("CREATE TRIGGER fail_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'update failed'); END");
    assert.throws(() => task.edit({ taskKey: "APP-1", title: "Nope" }, human), /update failed/);
    assert.throws(() => task.move({ taskKey: "APP-1", targetColumn: "Done" }, human), /update failed/);
    assert.throws(() => task.archive("APP-1", human), /update failed/);
    db.run("DROP TRIGGER fail_update");
    assert.throws(() => task.edit({ taskKey: "APP-1", addLabelNames: ["missing"] }, human), /does not exist/);
    assert.deepEqual(actions("APP-1"), ["create"]);
  `);
});

test("core requires a valid actor and never defaults one", () => {
  runActivityCheck(`
    assert.throws(() => task.create({ project_id: app.id, title: "No actor", description: null }), /actor is required/);
    assert.throws(() => task.create({ project_id: app.id, title: "Blank", description: null }, { ...human, name: "  " }), /Actor name cannot be blank/);
    assert.throws(() => task.create({ project_id: app.id, title: "Robot", description: null }, { ...human, kind: "robot" }));
    assert.equal(task.getAll().length, 0);
    task.create({ project_id: app.id, title: "Trimmed", description: null }, { ...human, name: "  Padded  " });
    assert.equal(task.activity("APP-1")[0].actor_name, "Padded");
    assert.throws(() => task.move({ taskKey: "APP-1", targetColumn: "Done" }), /actor is required/);
    assert.deepEqual(actions("APP-1"), ["create"]);
  `);
});

test("relations record the same row on both tasks, and deletions cascade to survivors", () => {
  runActivityCheck(`
    const first = task.create({ project_id: app.id, title: "First", description: null }, human);
    const second = task.create({ project_id: app.id, title: "Second", description: null }, human);
    const third = task.create({ project_id: app.id, title: "Third", description: null }, human);
    const dependency = relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "dependency" }, agent);
    const firstRow = task.activity("APP-1").at(-1);
    const secondRow = task.activity("APP-2").at(-1);
    assert.equal(firstRow.action, "relation_create");
    assert.deepEqual(firstRow.changes, secondRow.changes);
    assert.equal(firstRow.created_at, dependency.created_at);
    assert.deepEqual(firstRow.changes, {
      type: "dependency",
      source: { id: first.id, key: "APP-1" },
      target: { id: second.id, key: "APP-2" },
    });

    relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "APP-1", relation_type: "related" }, agent);
    relation.delete({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, agent);
    assert.deepEqual(actions("APP-3"), ["create", "relation_create", "relation_delete"]);
    assert.equal(task.activity("APP-1").at(-1).action, "relation_delete");

    task.delete("APP-2", human);
    assert.deepEqual(actions("APP-1"), ["create", "relation_create", "relation_create", "relation_delete", "relation_delete"]);
    assert.equal(task.activity("APP-1").at(-1).changes.target.key, "APP-2");
    const deletedHistory = dbActivity.getAllByEntityId(second.id);
    assert.deepEqual(deletedHistory.map((row) => row.action), ["create", "relation_create", "delete"]);
    assert.deepEqual(deletedHistory.at(-1).changes, { key: "APP-2", title: "Second" });
    assert.deepEqual(actions("APP-3"), ["create", "relation_create", "relation_delete"]);
  `);
});

test("deleting a label definition records an edit on each task that had it", () => {
  runActivityCheck(`
    label.create({ name: "bug" });
    task.create({ project_id: app.id, title: "Tagged", description: null, labelNames: ["bug"] }, human);
    task.create({ project_id: app.id, title: "Untagged", description: null }, human);
    label.delete({ name: "bug" }, agent);
    const row = task.activity("APP-1").at(-1);
    assert.equal(row.action, "edit");
    assert.equal(row.actor_name, "claude-code");
    assert.equal(row.created_at, task.getByKey("APP-1").updated_at);
    assert.deepEqual(row.changes, { labels: { added: [], removed: ["bug"] } });
    assert.deepEqual(actions("APP-2"), ["create"]);
  `);
});
