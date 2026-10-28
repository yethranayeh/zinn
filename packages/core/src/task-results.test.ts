import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, label, project, relation, task } from "../index";
import { getDb } from "./db";
import * as dbTask from "./db/task";
import { CoreError } from "./errors";
import { withStore, withTestStore } from "./testing";

test("task edits and label attachments report changes without writing for no-ops", () => {
  withTestStore(() => {
    const actor = { name: "Test", email: null, kind: "human" as const };
    const app = project.create({ key: "APP" }, actor);
    for (const name of ["bug", "docs", "later"]) {
      label.create({ name }, actor);
    }
    const created = task.create({
      project_id: app.id,
      title: "First",
      description: "Alpha\nbeta",
      priority: "high",
      labelNames: ["bug"],
    }, actor);
    const db = getDb();
    const previousTimestamp = 1;
    db.query("UPDATE task SET updated_at = ? WHERE id = ?").run(previousTimestamp, created.id);
    const existing = task.getByKey(created.key);
    const activity = task.activity(created.key);
    const beforeChanges = db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count;
    const edits: Array<Omit<Parameters<typeof task.edit>[0], "taskKey">> = [
      { title: " First " },
      { description: "Alpha\r\nbeta" },
      { priority: "high" },
      { addLabelNames: ["BUG"] },
      { removeLabelNames: ["docs"] },
      { title: "First", description: "Alpha\nbeta", priority: "high", addLabelNames: ["bug"], removeLabelNames: ["docs"] },
    ];
    for (const edit of edits) {
      assert.deepEqual(task.edit({ taskKey: created.key, ...edit }, actor), { task: existing, changed: false });
    }
    assert.deepEqual(task.label.add({ taskKey: created.key, labelNames: ["bug"] }, actor), { task: existing, changed: false });
    assert.deepEqual(task.label.remove({ taskKey: created.key, labelNames: ["docs"] }, actor), { task: existing, changed: false });
    assert.deepEqual(task.getByKey(created.key), existing);
    assert.deepEqual(task.activity(created.key), activity);
    assert.equal(db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count, beforeChanges);

    const changes = [
      () => task.edit({ taskKey: created.key, title: "Renamed" }, actor),
      () => task.edit({ taskKey: created.key, description: null }, actor),
      () => task.edit({ taskKey: created.key, priority: null }, actor),
      () => task.edit({ taskKey: created.key, addLabelNames: ["bug", "docs"] }, actor),
      () => task.label.add({ taskKey: created.key, labelNames: ["docs", "later"] }, actor),
      () => task.label.remove({ taskKey: created.key, labelNames: ["bug", "docs"] }, actor),
      () => task.label.remove({ taskKey: created.key, labelNames: ["bug", "later"] }, actor),
    ];
    for (const change of changes) {
      db.query("UPDATE task SET updated_at = ? WHERE id = ?").run(previousTimestamp, created.id);
      const previousActivityCount = task.activity(created.key).length;
      const result = change();
      assert.equal(result.changed, true);
      assert.deepEqual(result.task, task.getByKey(created.key));
      assert.ok(result.task.updated_at > previousTimestamp);
      assert.equal(task.activity(created.key).length, previousActivityCount + 1);
    }
    assert.deepEqual(task.label.getAll(created.key), []);
    const cleared = task.getByKey(created.key);
    assert.deepEqual(task.edit({ taskKey: created.key, description: " \n\t ", priority: null }, actor), { task: cleared, changed: false });
  });
});

test("task ordering reports changes and preserves rows and activity for every no-op placement", () => {
  withTestStore(() => {
    const actor = { name: "Test", email: null, kind: "human" as const };
    const app = project.create({ key: "APP" }, actor);
    for (const title of ["First", "Second", "Third"]) {
      task.create({ project_id: app.id, title }, actor);
    }
    const db = getDb();
    const previousTimestamp = 1;
    db.query("UPDATE task SET updated_at = ?").run(previousTimestamp);
    const before = task.getAll();
    const activityBefore = db.query("SELECT * FROM activity ORDER BY id").all();
    const writesBefore = db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count;
    const noOps: Array<Parameters<typeof task.order>[0]> = [
      { taskKey: "APP-1", direction: "top" },
      { taskKey: "APP-1", direction: "up" },
      { taskKey: "APP-3", direction: "bottom" },
      { taskKey: "APP-3", direction: "down" },
      { taskKey: "APP-2", direction: "before", targetTaskKey: "APP-3" },
      { taskKey: "APP-2", direction: "after", targetTaskKey: "APP-1" },
      { taskKey: "APP-2", direction: "before", targetTaskKey: "APP-2" },
      { taskKey: "APP-2", direction: "after", targetTaskKey: "APP-2" },
    ];
    for (const placement of noOps) {
      const result = task.order(placement, actor);
      assert.deepEqual(result, { task: before.find(entry => entry.key === placement.taskKey), changed: false });
    }
    assert.deepEqual(task.getAll(), before);
    assert.deepEqual(db.query("SELECT * FROM activity ORDER BY id").all(), activityBefore);
    assert.equal(db.query<{ count: number }>("SELECT total_changes() AS count").get()!.count, writesBefore);

    const moves: Array<Parameters<typeof task.order>[0]> = [
      { taskKey: "APP-3", direction: "top" },
      { taskKey: "APP-3", direction: "down" },
      { taskKey: "APP-3", direction: "up" },
      { taskKey: "APP-3", direction: "bottom" },
      { taskKey: "APP-3", direction: "before", targetTaskKey: "APP-2" },
      { taskKey: "APP-3", direction: "after", targetTaskKey: "APP-2" },
    ];
    for (const placement of moves) {
      const activityCount = task.activity(placement.taskKey).length;
      const result = task.order(placement, actor);
      assert.equal(result.changed, true);
      assert.deepEqual(result.task, task.getByKey(placement.taskKey));
      assert.ok(result.task.updated_at > previousTimestamp);
      assert.equal(task.activity(placement.taskKey).length, activityCount + 1);
      assert.equal(task.activity(placement.taskKey).at(-1)!.action, "order");
    }
    assert.deepEqual(task.getAll().filter(entry => entry.key !== "APP-3"), before.filter(entry => entry.key !== "APP-3"));
  });
});

test("public task results include keys across reads, mutations, and no-ops; DB rows stay raw", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };

      const app = project.create({ key: "app" }, actor);
      const other = project.create({ key: "other" }, actor);
      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      assert.equal(first.key, "APP-1");
      task.create({ project_id: app.id, title: "Second", description: null }, actor);
      task.create({ project_id: other.id, title: "Other", description: null }, actor);
      assert.equal(task.getByKey("app-1").key, "APP-1");
      assert.deepEqual(task.getAll().map(t => t.key).sort(), ["APP-1", "APP-2", "OTHER-1"]);
      assert.deepEqual(task.getAll({ projectKey: "app" }).map(t => t.key).sort(), ["APP-1", "APP-2"]);
      const check = (result: ReturnType<typeof task.getByKey>) => { assert.equal(result.key, "APP-1"); return result; };
      check(task.edit({ taskKey: "APP-1", title: "Edited" }, actor).task);
      const edited = task.getByKey("APP-1");
      assert.deepEqual(check(task.edit({ taskKey: "APP-1", title: "Edited" }, actor).task), edited);
      check(task.order({ taskKey: "APP-1", direction: "bottom" }, actor).task);
      const ordered = task.getByKey("APP-1");
      assert.deepEqual(check(task.order({ taskKey: "APP-1", direction: "bottom" }, actor).task), ordered);
      check(task.order({ taskKey: "APP-1", direction: "before", targetTaskKey: "APP-1" }, actor).task);
      check(task.move({ taskKey: "APP-1", targetColumn: "TODO" }, actor));
      const moved = task.getByKey("APP-1");
      assert.deepEqual(check(task.move({ taskKey: "APP-1", targetColumn: "TODO" }, actor)), moved);
      const archived = check(task.archive("APP-1", actor));
      assert.deepEqual(check(task.archive("APP-1", actor)), archived);
      assert.equal(task.getAll({ archive: "archived" })[0]!.key, "APP-1");
      assert.equal(task.getAll({ projectKey: "app", archive: "archived" })[0]!.key, "APP-1");
      assert.equal(task.getAll({ archive: "all" }).length, 3);
      const active = check(task.unarchive("APP-1", actor));
      assert.deepEqual(check(task.unarchive("APP-1", actor)), active);
      assert.equal("key" in dbTask.getById(first.id)!, false);
      assert.equal("key" in dbTask.getAll()[0]!, false);
      check(task.delete("APP-1", actor));
      assert.equal(dbTask.getById(first.id), null);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bulk task operations log activity per task and roll back entirely when one task fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP" }, actor);
      const other = project.create({ key: "OTHER" }, actor);
      for (const title of ["One", "Two", "Three"]) {
        task.create({ project_id: app.id, title, description: null }, actor);
      }
      task.create({ project_id: other.id, title: "Elsewhere", description: null }, actor);
      const actions = (key: string) => task.activity(key).map((row) => row.action);

      const moved = task.moveMany({ taskKeys: ["APP-3", "OTHER-1", "APP-1"], targetColumn: "todo" }, actor);
      assert.deepEqual(moved.map((change) => change.task.key), ["APP-3", "OTHER-1", "APP-1"]);
      assert.deepEqual(moved.map((change) => change.changed), [true, true, true]);
      assert.deepEqual(task.getAll({ projectKey: "app" }).map((t) => t.key), ["APP-2", "APP-3", "APP-1"]);
      assert.deepEqual(actions("APP-3"), ["create", "move"]);
      assert.deepEqual(actions("OTHER-1"), ["create", "move"]);

      task.archive("APP-2", actor);
      assert.throws(() => task.moveMany({ taskKeys: ["APP-3", "APP-2"], targetColumn: "Done" }, actor), (error) => error instanceof CoreError && error.kind === "conflict" && error.facts.reason === "archived" && error.facts.key === "APP-2");
      assert.throws(() => task.archiveMany(["APP-1", "APP-404"], actor), /APP-404/);
      assert.throws(() => task.unarchiveMany(["APP-2", "APP-404"], actor), /APP-404/);
      assert.equal(task.getByKey("APP-3").column_id, task.getByKey("APP-1").column_id);
      assert.equal(task.getByKey("APP-1").archived_at, null);
      assert.notEqual(task.getByKey("APP-2").archived_at, null);
      assert.deepEqual(actions("APP-3"), ["create", "move"]);
      assert.deepEqual(actions("APP-1"), ["create", "move"]);
      assert.deepEqual(actions("APP-2"), ["create", "archive"]);

      assert.deepEqual(task.archiveMany(["APP-1", "APP-2", "APP-1"], actor).map((change) => [change.task.key, change.changed]), [["APP-1", true], ["APP-2", false], ["APP-1", false]]);
      assert.deepEqual(actions("APP-1"), ["create", "move", "archive"]);
      assert.deepEqual(actions("APP-2"), ["create", "archive"]);
      assert.deepEqual(task.unarchiveMany(["APP-2", "APP-1", "APP-3"], actor).map((change) => [change.task.key, change.changed]), [["APP-2", true], ["APP-1", true], ["APP-3", false]]);
      assert.deepEqual(task.getAll({ projectKey: "app" }).map((t) => t.key), ["APP-2", "APP-3", "APP-1"]);
      assert.deepEqual(task.moveMany({ taskKeys: ["APP-2", "APP-2"], targetColumn: "Done" }, actor).map((change) => change.changed), [true, false]);
      assert.deepEqual(actions("APP-2"), ["create", "archive", "unarchive", "move"]);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task lists across projects follow project key, column order, and task order", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const later = project.create({ key: "BBB" }, actor);
      const earlier = project.create({ key: "AAA" }, actor);
      for (const title of ["One", "Two", "Three"]) {
        task.create({ project_id: later.id, title, description: null }, actor);
      }
      task.create({ project_id: earlier.id, title: "Only", description: null }, actor);
      task.move({ taskKey: "BBB-1", targetColumn: "In Progress" }, actor);
      task.order({ taskKey: "BBB-3", direction: "top" }, actor);
      task.archive("BBB-2", actor);
      assert.deepEqual(task.getAll().map(t => t.key), ["AAA-1", "BBB-3", "BBB-1"]);
      task.unarchive("BBB-2", actor);
      task.order({ taskKey: "BBB-2", direction: "top" }, actor);
      assert.deepEqual(task.getAll().map(t => t.key), ["AAA-1", "BBB-2", "BBB-3", "BBB-1"]);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("column filtering narrows ordered project and global lists together with labels and archive status", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-column-filter-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const later = project.create({ key: "BBB" }, actor);
      const earlier = project.create({ key: "AAA" }, actor);
      const missing = project.create({ key: "CCC" }, actor);
      column.edit({ projectKey: "CCC", columnName: "In Progress", name: "Working" }, actor);
      label.create({ name: "CLI" }, actor);
      label.create({ name: "Groom" }, actor);
      const create = (projectId: string, title: string, columnName: string, labelNames: string[] = []) => task.create({
        project_id: projectId, title, columnName, labelNames,
      }, actor);
      create(later.id, "Archived", "In Progress", ["CLI", "Groom"]);
      create(later.id, "Both", "In Progress", ["CLI", "Groom"]);
      create(later.id, "CLI only", "In Progress", ["CLI"]);
      create(later.id, "Backlog", "Backlog", ["CLI", "Groom"]);
      create(earlier.id, "Earlier", "In Progress", ["CLI", "Groom"]);
      create(missing.id, "Different column", "Working", ["CLI", "Groom"]);
      task.archive("BBB-1", actor);
      task.order({ taskKey: "BBB-3", direction: "top" }, actor);
      const keys = (props: Parameters<typeof task.getAll>[0]) => task.getAll(props).map((row) => row.key);
      assert.deepEqual(keys({ columnName: " In Progress " }), ["AAA-1", "BBB-3", "BBB-2"]);
      assert.deepEqual(keys({ columnName: "IN PROGRESS" }), ["AAA-1", "BBB-3", "BBB-2"]);
      assert.deepEqual(keys({ projectKey: "bbb", columnName: "in progress" }), ["BBB-3", "BBB-2"]);
      for (const projectKey of [undefined, "BBB"]) {
        for (const archive of ["active", "archived", "all"] as const) {
          const props = { projectKey, archive, labelNames: ["cli", "GROOM"] };
          const unfiltered = task.getAll(props);
          assert.deepEqual(
            task.getAll({ ...props, columnName: "In Progress" }),
            unfiltered.filter((row) => row.key !== "BBB-4" && row.key !== "CCC-1"),
          );
        }
      }
      assert.deepEqual(keys({ columnName: "In Progress", archive: "archived" }), ["BBB-1"]);
      assert.deepEqual(keys({ columnName: "In Progress", archive: "all" }), ["AAA-1", "BBB-3", "BBB-2", "BBB-1"]);
      for (const projectKey of [undefined, "BBB", "CCC"]) {
        for (const columnName of ["Nowhere", "Review", "Progress"]) {
          assert.deepEqual(task.getAll({ projectKey, columnName, archive: "all" }), []);
        }
      }
      assert.deepEqual(keys({ projectKey: "CCC", columnName: "In Progress" }), []);
      assert.throws(() => task.getAll({ columnName: "Nowhere", labelNames: ["missing"] }), /label/);
      assert.throws(() => task.getAll({ projectKey: "NOPE", columnName: "Nowhere" }), (error) => error instanceof CoreError && error.kind === "missing");
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task create places a task last in the named column and a bad column saves nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP", name: "App" }, actor);
      const [backlog, , inProgress] = column.getAllByProjectKey("APP");
      const count = (table: string) => getDb().query<{ n: number }>("SELECT COUNT(*) AS n FROM " + table).get()!.n;

      const first = task.create({ project_id: app.id, title: "First", description: null }, actor);
      assert.equal(first.column_id, backlog!.id);
      const second = task.create({ project_id: app.id, title: "Second", description: null, columnName: "in progress" }, actor);
      const third = task.create({ project_id: app.id, title: "Third", description: null, columnName: "IN PROGRESS" }, actor);
      assert.equal(second.column_id, inProgress!.id);
      assert.deepEqual(dbTask.getAllByColumnId(inProgress!.id).map((t) => t.id), [second.id, third.id]);
      assert.deepEqual(dbTask.getAllByColumnId(backlog!.id).map((t) => t.id), [first.id]);

      assert.deepEqual(task.activity(third.key).map((row) => row.action), ["create"]);
      assert.deepEqual(task.activity(third.key)[0]!.changes!.column, { id: inProgress!.id, name: "In Progress" });

      const tasksBefore = count("task");
      const activityBefore = count("activity");
      assert.throws(
        () => task.create({ project_id: app.id, title: "Lost", description: null, columnName: "Nowhere" }, actor),
        (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "column" && error.facts.key === "Nowhere",
      );
      assert.equal(count("task"), tasksBefore);
      assert.equal(count("activity"), activityBefore);
      assert.equal(project.getById(app.id)!.task_count, 3);
      assert.equal(task.create({ project_id: app.id, title: "Fourth", description: null }, actor).key, "APP-4");
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task create saves requested relations with the new task as source and records them like relation create", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP", name: "App" }, actor);
      const other = project.create({ key: "OTHER", name: "Other" }, actor);
      task.create({ project_id: app.id, title: "Parent", description: null }, actor);
      task.create({ project_id: app.id, title: "Needed", description: null }, actor);
      task.create({ project_id: other.id, title: "Original", description: null }, actor);
      task.create({ project_id: other.id, title: "Related", description: null }, actor);
      const linked = (key: string) => relation.getAll(key, { include: { tasks: true } })
        .map((r) => [r.relation_type, r.source!.key, r.target!.key])
        .sort();

      const created = task.create({
        project_id: app.id,
        title: "Child",
        description: null,
        relations: [
          { relation_type: "subtask", targetTaskKey: "APP-1" },
          { relation_type: "dependency", targetTaskKey: "app-2" },
          { relation_type: "duplicate", targetTaskKey: "OTHER-1" },
          { relation_type: "related", targetTaskKey: "OTHER-2" },
        ],
      }, actor);
      assert.equal(created.key, "APP-3");
      assert.deepEqual(linked("APP-3"), [
        ["dependency", "APP-3", "APP-2"],
        ["duplicate", "APP-3", "OTHER-1"],
        ["related", "OTHER-2", "APP-3"],
        ["subtask", "APP-3", "APP-1"],
      ]);

      const childActions = task.activity("APP-3").map((row) => row.action);
      assert.deepEqual(childActions, ["create", "relation_create", "relation_create", "relation_create", "relation_create"]);
      assert.deepEqual(Object.keys(task.activity("APP-3")[0]!.changes!), ["title", "description", "priority", "due_at", "column", "labels"]);
      const parentRow = task.activity("APP-1").at(-1);
      assert.equal(parentRow!.action, "relation_create");
      assert.deepEqual(parentRow!.changes, task.activity("APP-3")[1]!.changes);
      assert.equal(parentRow!.changes!.type, "subtask");
      assert.equal((parentRow!.changes!.source as { key: string }).key, "APP-3");
      assert.equal(task.activity("OTHER-1").at(-1)!.action, "relation_create");

      const plain = task.create({ project_id: app.id, title: "Plain", description: null }, actor);
      assert.deepEqual(relation.getAll(plain.key), []);
      assert.deepEqual(task.activity(plain.key).map((row) => row.action), ["create"]);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task create deduplicates identical relation requests by resolved task identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP", name: "App" }, actor);
      task.create({ project_id: app.id, title: "First", description: null }, actor);
      task.create({ project_id: app.id, title: "Second", description: null }, actor);

      const created = task.create({
        project_id: app.id,
        title: "Third",
        description: null,
        relations: [
          { relation_type: "dependency", targetTaskKey: "APP-1" },
          { relation_type: "dependency", targetTaskKey: "APP-1" },
          { relation_type: "dependency", targetTaskKey: "app-1" },
          { relation_type: "related", targetTaskKey: "APP-2" },
          { relation_type: "related", targetTaskKey: "APP-2" },
        ],
      }, actor);

      const stored = relation.getAll(created.key, { include: { tasks: true } })
        .map((r) => [r.relation_type, r.source!.key, r.target!.key])
        .sort();
      assert.deepEqual(stored, [
        ["dependency", "APP-3", "APP-1"],
        ["related", "APP-2", "APP-3"],
      ]);
      assert.deepEqual(
        task.activity("APP-3").map((row) => row.action),
        ["create", "relation_create", "relation_create"],
      );
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task create with a bad relation target or a broken relation rule saves nothing and uses no task number", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-task-results-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test Human", email: null, kind: "human" as const };
      const app = project.create({ key: "APP", name: "App" }, actor);
      task.create({ project_id: app.id, title: "First", description: null }, actor);
      task.create({ project_id: app.id, title: "Second", description: null }, actor);
      const count = (table: string) => getDb().query<{ n: number }>("SELECT COUNT(*) AS n FROM " + table).get()!.n;
      const snapshot = () => ({
        tasks: count("task"),
        activity: count("activity"),
        relations: count("task_relations"),
        taskCount: project.getById(app.id)!.task_count,
        firstActivity: task.activity("APP-1").length,
        secondActivity: task.activity("APP-2").length,
      });
      const before = snapshot();
      const createWith = (relations: NonNullable<Parameters<typeof task.create>[0]["relations"]>) => () => task.create({ project_id: app.id, title: "Lost", description: null, relations }, actor);

      // A valid relation ahead of the bad one is rolled back with everything else.
      assert.throws(
        createWith([
          { relation_type: "subtask", targetTaskKey: "APP-1" },
          { relation_type: "dependency", targetTaskKey: "APP-99" },
        ]),
        (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "task" && error.facts.key === "APP-99",
      );
      assert.deepEqual(snapshot(), before);

      assert.throws(
        createWith([
          { relation_type: "related", targetTaskKey: "APP-2" },
          { relation_type: "dependency", targetTaskKey: "not a key" },
        ]),
        (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "taskKey" && error.message.includes("not a key"),
      );
      assert.deepEqual(snapshot(), before);

      assert.throws(createWith([{ relation_type: "related", targetTaskKey: "NOPE-1" }]), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "project" && error.facts.key === "NOPE");
      assert.deepEqual(snapshot(), before);

      // The relation rules of relation create apply: a task has one parent.
      assert.throws(
        createWith([
          { relation_type: "subtask", targetTaskKey: "APP-1" },
          { relation_type: "subtask", targetTaskKey: "APP-2" },
        ]),
        (error) => error instanceof CoreError && error.kind === "conflict" && error.facts.reason === "parent_exists",
      );
      assert.deepEqual(snapshot(), before);

      // @ts-expect-error Exercise runtime validation of an invalid relation type.
      assert.throws(createWith([{ relation_type: "bogus", targetTaskKey: "APP-1" }]));
      assert.deepEqual(snapshot(), before);

      const next = task.create({ project_id: app.id, title: "Real", description: null }, actor);
      assert.equal(next.key, "APP-3");
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
