import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runActivityCheck(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-activity-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column, task, relation, label } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import * as dbActivity from ${JSON.stringify(new URL("./db/activity.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      const human = { name: "Test Human", email: "human@example.com", kind: "human" };
      const agent = { name: "claude-code", email: null, kind: "agent" };
      const app = project.create({ key: "APP" }, human);
      const actions = (key) => task.activity(key).map((row) => row.action);
      ${script}
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("descriptions normalize before persistence and activity across projects, tasks and labels", () => {
  runActivityCheck(`
    const entities = [
      {
        type: "project",
        create: (description, index) => project.create({ key: "DESC" + index, description }, human),
        edit: (entity, changes) => project.edit({ projectKey: entity.key, ...changes }, human),
        rename: { name: "Renamed" },
      },
      {
        type: "task",
        create: (description, index) => task.create({ project_id: app.id, title: "Task " + index, description }, human),
        edit: (entity, changes) => task.edit({ taskKey: entity.key, ...changes }, human),
        rename: { title: "Renamed" },
      },
      {
        type: "label",
        create: (description, index) => label.create({ name: "label-" + index, description }, human),
        edit: (entity, changes) => label.edit({ labelName: entity.name, ...changes }, human),
        rename: { color: "red" },
      },
    ];

    for (const entity of entities) {
      const descriptions = [
        { description: undefined, expectedDescription: null },
        { description: "", expectedDescription: null },
        { description: null, expectedDescription: null },
        { description: " \\n\\t ", expectedDescription: null },
        { description: "  Context\\nMore text  ", expectedDescription: "  Context\\nMore text  " },
        { description: "\\tFirst\\n\\tSecond\\n", expectedDescription: "\\tFirst\\n\\tSecond\\n" },
      ];
      for (const [index, { description, expectedDescription }] of descriptions.entries()) {
        const created = entity.create(description, index);
        const read = () => getDb().query("SELECT * FROM " + entity.type + " WHERE id = ?").get(created.id);
        const history = () => dbActivity.getAllByEntity(entity.type, created.id);
        assert.equal(created.description, expectedDescription);
        assert.equal(read().description, expectedDescription);
        assert.equal(history()[0].changes.description, expectedDescription);

        const renamed = entity.edit(created, entity.rename);
        assert.equal(renamed.description, expectedDescription);
        assert.equal(read().description, expectedDescription);

        const clearInput = ["", null, " \\n\\t "][index % 3];
        const beforeClear = history();
        const cleared = entity.edit(renamed, { description: clearInput });
        assert.equal(cleared.description, null);
        assert.equal(read().description, null);
        if (expectedDescription === null) {
          assert.deepEqual(history(), beforeClear);
          assert.deepEqual(cleared, renamed);
        } else {
          assert.equal(history().length, beforeClear.length + 1);
          assert.deepEqual(history().at(-1).changes, { description: [expectedDescription, null] });
        }

        const beforeNoOps = history();
        const beforeRow = read();
        for (const description of ["", null, " \\n\\t "]) {
          assert.deepEqual(entity.edit(cleared, { description }), cleared);
        }
        assert.deepEqual(read(), beforeRow);
        assert.deepEqual(history(), beforeNoOps);
      }
    }
  `);
});

test("clearing a task description removes its search terms and stores null in the index", () => {
  runActivityCheck(`
    const created = task.create({ project_id: app.id, title: "Searchable", description: "descriptionneedle" }, human);
    assert.deepEqual(task.search({ query: "descriptionneedle" }).tasks.map((row) => row.key), [created.key]);
    task.edit({ taskKey: created.key, description: " \\n\\t " }, human);
    assert.deepEqual(task.search({ query: "descriptionneedle" }).tasks, []);
    assert.equal(task.search({ query: "Searchable" }).tasks[0].description, null);
    assert.equal(getDb().query("SELECT description FROM task_search WHERE task_id = ?").get(created.id).description, null);
  `);
});

test("each task mutation records one row with its actor and changes", () => {
  runActivityCheck(`
    label.create({ name: "bug" }, human);
    label.create({ name: "docs" }, human);
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
    label.create({ name: "bug" }, human);
    label.create({ name: "docs" }, human);
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
    const later = column.create({ projectKey: "APP", name: "Later" }, human);
    const bug = label.create({ name: "bug" }, human);
    const db = getDb();
    db.run("CREATE TRIGGER fail_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'activity failed'); END");
    assert.throws(() => project.create({ key: "OTHER" }, human), /activity failed/);
    assert.equal(project.getByKey("OTHER"), null);
    assert.throws(() => label.create({ name: "docs" }, human), /activity failed/);
    assert.equal(label.getByName("docs") == null, true);
    db.run("DROP TRIGGER fail_activity");

    db.run("CREATE TRIGGER fail_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'update failed'); END");
    assert.throws(() => task.edit({ taskKey: "APP-1", title: "Nope" }, human), /update failed/);
    assert.throws(() => task.move({ taskKey: "APP-1", targetColumn: "Done" }, human), /update failed/);
    assert.throws(() => task.archive("APP-1", human), /update failed/);
    db.run("DROP TRIGGER fail_update");
    assert.throws(() => task.edit({ taskKey: "APP-1", addLabelNames: ["missing"] }, human), /does not exist/);
    assert.deepEqual(actions("APP-1"), ["create"]);

    db.run("CREATE TRIGGER fail_project_update BEFORE UPDATE ON project BEGIN SELECT RAISE(ABORT, 'project update failed'); END");
    assert.throws(() => project.edit({ projectKey: "APP", name: "Nope" }, human), /project update failed/);
    db.run("DROP TRIGGER fail_project_update");
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).map((row) => row.action), ["create"]);

    db.run("CREATE TRIGGER fail_column_update BEFORE UPDATE ON project_column BEGIN SELECT RAISE(ABORT, 'column update failed'); END");
    assert.throws(() => column.edit({ projectKey: "APP", columnName: "Later", name: "Nope" }, human), /column update failed/);
    db.run("DROP TRIGGER fail_column_update");
    assert.deepEqual(dbActivity.getAllByEntity("column", later.id).map((row) => row.action), ["create"]);

    db.run("CREATE TRIGGER fail_label_update BEFORE UPDATE ON label BEGIN SELECT RAISE(ABORT, 'label update failed'); END");
    assert.throws(() => label.edit({ labelName: "bug", name: "Nope" }, human), /label update failed/);
    db.run("DROP TRIGGER fail_label_update");
    assert.deepEqual(dbActivity.getAllByEntity("label", bug.id).map((row) => row.action), ["create"]);

    db.run("CREATE TRIGGER fail_project_delete BEFORE DELETE ON project BEGIN SELECT RAISE(ABORT, 'project delete failed'); END");
    assert.throws(() => project.delete("APP", human), /project delete failed/);
    db.run("DROP TRIGGER fail_project_delete");
    assert.equal(project.getById(app.id).key, "APP");
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).map((row) => row.action), ["create"]);
  `);
});

test("core requires a valid actor and never defaults one", () => {
  runActivityCheck(`
    assert.throws(() => project.create({ key: "NOACTOR" }), /actor is required/);
    assert.equal(project.getByKey("NOACTOR"), null);
    assert.throws(() => project.edit({ projectKey: "APP", name: "No actor" }), /actor is required/);
    assert.throws(() => column.create({ projectKey: "APP", name: "No actor" }), /actor is required/);
    assert.throws(() => label.create({ name: "no-actor" }), /actor is required/);
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
    const deletedHistory = dbActivity.getAllByEntity("task", second.id);
    assert.deepEqual(deletedHistory.map((row) => row.action), ["create", "relation_create", "delete"]);
    assert.deepEqual(deletedHistory.at(-1).changes, { key: "APP-2", title: "Second" });
    assert.deepEqual(actions("APP-3"), ["create", "relation_create", "relation_delete"]);
  `);
});

test("deleting a label definition records an edit on each task that had it", () => {
  runActivityCheck(`
    label.create({ name: "bug" }, human);
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

test("project, column, and label definition mutations record their own activity", () => {
  runActivityCheck(`
    const initialProjectActivity = dbActivity.getAllByEntity("project", app.id);
    assert.equal(initialProjectActivity.length, 1);
    assert.equal(initialProjectActivity[0].action, "create");
    assert.deepEqual(initialProjectActivity[0].changes, {
      key: "APP",
      name: "APP",
      description: null,
      columns: column.getAllByProjectKey("APP").map(({ id, name }) => ({ id, name })),
    });

    project.edit({ projectKey: "APP", name: "Application" }, human);
    project.edit({ projectKey: "APP", name: "Application" }, agent);
    assert.deepEqual(
      dbActivity.getAllByEntity("project", app.id).map((row) => row.action),
      ["create", "edit"],
    );
    assert.deepEqual(dbActivity.getAllByEntity("project", app.id).at(-1).changes, {
      name: ["APP", "Application"],
    });

    const createdColumn = column.create({ projectKey: "APP", name: "Later" }, agent);
    column.edit({ projectKey: "APP", columnName: "Later", name: "Someday" }, human);
    column.edit({ projectKey: "APP", columnName: "Someday", name: "Someday" }, agent);
    column.order({ projectKey: "APP", columnName: "Someday", direction: "first" }, agent);
    column.order({ projectKey: "APP", columnName: "Someday", direction: "first" }, human);
    const columnActivity = dbActivity.getAllByEntity("column", createdColumn.id);
    assert.deepEqual(columnActivity.map((row) => row.action), ["create", "edit", "order"]);
    assert.deepEqual(columnActivity[0].changes, {
      project: { id: app.id, key: "APP" },
      name: "Later",
    });
    assert.deepEqual(columnActivity[1].changes, { name: ["Later", "Someday"] });
    assert.equal(columnActivity[2].changes, null);

    const createdLabel = label.create({ name: "bug", description: "Broken", color: "red" }, human);
    label.edit({ labelName: "bug", name: "defect", description: "Unexpected", color: "blue" }, agent);
    label.edit({ labelName: "defect", name: "defect" }, human);
    label.delete({ name: "defect" }, agent);
    const labelActivity = dbActivity.getAllByEntity("label", createdLabel.id);
    assert.deepEqual(labelActivity.map((row) => row.action), ["create", "edit", "delete"]);
    assert.deepEqual(labelActivity[1].changes, {
      name: ["bug", "defect"],
      description: ["Broken", "Unexpected"],
      color: ["red", "blue"],
    });
    assert.deepEqual(labelActivity[2].changes, {
      name: "defect",
      description: "Unexpected",
      color: "blue",
    });
  `);
});

test("project deletion records one aggregate event with ordered columns and task snapshots", () => {
  runActivityCheck(`
    const extraColumn = column.create({ projectKey: "APP", name: "Icebox" }, human);
    column.order({ projectKey: "APP", columnName: "Icebox", direction: "first" }, human);
    const first = task.create({ project_id: app.id, title: "First", description: null }, human);
    const second = task.create({ project_id: app.id, title: "Second", description: null }, agent);
    task.archive("APP-2", agent);
    const expectedColumns = column.getAllByProjectKey("APP").map(({ id, name }) => ({ id, name }));

    project.delete("APP", human);

    const projectActivity = dbActivity.getAllByEntity("project", app.id);
    assert.deepEqual(projectActivity.map((row) => row.action), ["create", "delete"]);
    assert.deepEqual(projectActivity.at(-1).changes, {
      key: "APP",
      name: "APP",
      description: null,
      columns: expectedColumns,
      tasks: [
        { id: first.id, key: "APP-1", title: "First" },
        { id: second.id, key: "APP-2", title: "Second" },
      ],
    });
    assert.deepEqual(dbActivity.getAllByEntity("task", first.id).map((row) => row.action), ["create"]);
    assert.deepEqual(dbActivity.getAllByEntity("task", second.id).map((row) => row.action), ["create", "archive"]);
    assert.deepEqual(dbActivity.getAllByEntity("column", extraColumn.id).map((row) => row.action), ["create", "order"]);
    assert.equal(project.getById(app.id), null);
  `);
});


test("project description edits preserve omitted fields, skip no-ops and record only changes", () => {
  runActivityCheck(`
    const described = project.create({ key: "DESC", description: "Purpose\\nContext" }, human);
    assert.equal(described.description, "Purpose\\nContext");
    assert.equal(dbActivity.getAllByEntity("project", described.id)[0].changes.description, described.description);
    const renamed = project.edit({ projectKey: "DESC", name: "Named" }, human);
    assert.equal(renamed.description, described.description);
    const edited = project.edit({ projectKey: "DESC", description: "New" }, human);
    assert.equal(edited.name, "Named");
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id).at(-1).changes, { description: [described.description, "New"] });
    const before = dbActivity.getAllByEntity("project", described.id);
    assert.deepEqual(project.edit({ projectKey: "DESC", description: "New" }, human), edited);
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id), before);
    assert.equal(project.edit({ projectKey: "DESC", description: "" }, human).description, null);
    assert.equal(project.edit({ projectKey: "DESC", description: null }, human).description, null);
    getDb().run("CREATE TRIGGER reject_description BEFORE UPDATE ON project BEGIN SELECT RAISE(ABORT, 'rejected'); END");
    const beforeFailure = dbActivity.getAllByEntity("project", described.id);
    assert.throws(() => project.edit({ projectKey: "DESC", description: "fail" }, human), /rejected/);
    assert.deepEqual(dbActivity.getAllByEntity("project", described.id), beforeFailure);
    assert.equal(project.getByKey("DESC").description, null);
  `);
});
