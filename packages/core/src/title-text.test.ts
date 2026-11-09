import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, comment, label, project, task } from "../index";
import { getDb } from "./db";
import { CoreError } from "./errors";
import { withStore } from "./testing";
import type { Activity } from "./types";

type StoredActivity = Omit<Activity, "changes"> & { changes: string | null };

test("normalized titles persist before no-op detection, activity and search; body text keeps formatting", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-title-text-"));
  try {
    withStore(directory, () => {

      const actor = { name: "Test", email: null, kind: "human" as const };
      const body = "\n  Body text\n";
      const app = project.create({ key: "APP", name: " App ", description: body }, actor);
      const next = column.create({ projectKey: "APP", name: " Next ", category: "todo" }, actor);
      const bug = label.create({ name: " bug ", description: body }, actor);
      const first = task.create({ project_id: app.id, title: " First ", description: body, columnName: " Next ", labelNames: [" bug "] }, actor);
      const note = comment.create({ taskKey: first.key, text: body }, actor);
      assert.equal(app.name, "App");
      assert.equal(next.name, "Next");
      assert.equal(bug.name, "bug");
      assert.equal(first.title, "First");
      assert.equal(first.column_id, next.id);
      assert.equal(app.description, body);
      assert.equal(bug.description, body);
      assert.equal(first.description, body);
      assert.equal(note.text, body);
      const db = getDb();
      const currentProject = project.getByKey("APP");
      const currentTask = task.getByKey(first.key);
      const before = db.query<StoredActivity>("SELECT * FROM activity ORDER BY id").all();
      assert.deepEqual(project.edit({ projectKey: "APP", name: " App " }, actor).project, currentProject);
      assert.deepEqual(column.edit({ projectKey: "APP", columnName: " Next ", name: " Next " }, actor).column, next);
      assert.deepEqual(label.edit({ labelName: " bug ", name: " bug " }, actor).label, bug);
      assert.deepEqual(task.edit({ taskKey: first.key, title: " First " }, actor).task, currentTask);
      assert.deepEqual(task.move({ taskKey: first.key, targetColumn: " Next " }, actor), currentTask);
      assert.deepEqual(task.moveMany({ taskKeys: [first.key], targetColumn: " Next " }, actor), [{ task: currentTask, changed: false }]);
      assert.deepEqual(db.query<StoredActivity>("SELECT * FROM activity ORDER BY id").all(), before);
      assert.deepEqual(task.getAll({ columnName: " Next " }).map(t => t.key), [first.key]);
      for (const targetColumn of [" Next\n", "\tNext", " "]) {
        assert.throws(() => task.move({ taskKey: first.key, targetColumn }, actor), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.length === 0);
        assert.throws(() => task.moveMany({ taskKeys: [first.key], targetColumn }, actor), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.length === 0);
      }
      assert.equal(task.edit({ taskKey: first.key, title: " Renamed " }, actor).task.title, "Renamed");
      assert.deepEqual(task.search({ query: "Renamed" }).tasks.map(t => t.key), [first.key]);
      const changes = JSON.parse(db.query<{ changes: string }>("SELECT changes FROM activity WHERE entity_id = ? AND action = 'edit' ORDER BY id DESC LIMIT 1").get(first.id)!.changes);
      assert.deepEqual(changes.title, ["First", "Renamed"]);
    });

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
