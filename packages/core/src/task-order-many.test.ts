import type { TaskOrderManyInput } from "../index";

import { test, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { activity, CoreError, project, task } from "../index";
import { getDb } from "./db";
import * as dbTask from "./db/task";
import { withTestStore } from "./testing";

const actor = { name: "Test", email: null, kind: "human" as const };

function seed() {
  const app = project.create({ key: "APP" }, actor);
  for (const title of ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"]) {
    task.create({ project_id: app.id, title }, actor);
  }
}

function snapshot() {
  return {
    tasks: getDb().query("SELECT * FROM task ORDER BY id").all(),
    activity: getDb().query("SELECT * FROM activity ORDER BY id").all(),
  };
}

test("bulk ordering matches sequential single orders, including each step's result and activity", () => {
  const placements: Array<TaskOrderManyInput> = [
    { taskKeys: ["APP-4", "APP-2", "APP-5"], direction: "top" },
    { taskKeys: ["APP-4", "APP-2", "APP-5"], direction: "bottom" },
    { taskKeys: ["APP-4", "APP-2", "APP-5"], direction: "before", targetTaskKey: "APP-3" },
    { taskKeys: ["APP-4", "APP-2", "APP-5"], direction: "after", targetTaskKey: "APP-3" },
    { taskKeys: ["APP-1", "APP-2"], direction: "top" },
    { taskKeys: ["APP-2", "APP-1"], direction: "top" },
  ];
  for (const placement of placements) {
    const run = (bulk: boolean) => withTestStore(() => {
      seed();
      task.order({ taskKey: "APP-3", direction: "before", targetTaskKey: "APP-2" }, actor);
      const previousActivity = new Set(activity.getAll().events.map(entry => entry.id));
      const result = bulk ? task.orderMany(placement, actor) : placement.taskKeys.map((taskKey, index) => {
        const step: Parameters<typeof task.order>[0] = index === 0
          ? { ...placement, taskKey }
          : { taskKey, direction: "after", targetTaskKey: placement.taskKeys[index - 1]! };
        return task.order(step, actor);
      });
      const keysById = new Map(task.getAll().map(entry => [entry.id, entry.key]));
      return {
        order: task.getAll().map(entry => entry.key),
        results: result.map(({ task: entry, changed }) => ({ key: entry.key, order: entry.task_order, changed })),
        activity: activity.getAll().events.filter(entry => !previousActivity.has(entry.id)).reverse().map(entry => {
          const { id, created_at, entity_id, ...facts } = entry;
          return { ...facts, key: keysById.get(entity_id) };
        }),
      };
    });
    assert.deepEqual(run(true), run(false));
  }
});

test("bulk ordering leaves satisfied steps and displaced neighbours untouched", () => {
  withTestStore(() => {
    seed();
    task.order({ taskKey: "APP-3", direction: "before", targetTaskKey: "APP-2" }, actor);
    const before = task.getAll();
    const eventsBefore = activity.getAll().events.length;
    const result = task.orderMany({ taskKeys: ["app-1", "APP-2"], direction: "top" }, actor);
    assert.deepEqual(result.map(entry => entry.changed), [false, true]);
    assert.deepEqual(result[0]!.task, before[0]);
    assert.deepEqual(task.getByKey("APP-3"), before.find(entry => entry.key === "APP-3"));
    assert.deepEqual(task.getAll().map(entry => entry.key), ["APP-1", "APP-2", "APP-3", "APP-4", "APP-5", "APP-6"]);
    assert.equal(activity.getAll().events.length, eventsBefore + 1);
    const unchanged = snapshot();
    assert.deepEqual(task.orderMany({ taskKeys: ["APP-1", "APP-2"], direction: "top" }, actor).map(entry => entry.changed), [false, false]);
    assert.deepEqual(snapshot(), unchanged);
    assert.equal(task.orderMany({ taskKeys: ["APP-1"], direction: "before", targetTaskKey: "app-1" }, actor)[0]!.changed, false);
    const firstTask = task.getByKey("APP-1");
    const reverseEvents = activity.getAll().events.length;
    assert.deepEqual(task.orderMany({ taskKeys: ["APP-2", "APP-1"], direction: "top" }, actor).map(entry => entry.changed), [true, false]);
    assert.deepEqual(task.getByKey("APP-1"), firstTask);
    assert.equal(activity.getAll().events.length, reverseEvents + 1);
  });
});

test("bulk ordering refusals leave all rows and activity unchanged", () => {
  withTestStore(() => {
    seed();
    const other = project.create({ key: "OTHER" }, actor);
    task.create({ project_id: other.id, title: "Other" }, actor);
    task.move({ taskKey: "APP-5", targetColumn: "TODO" }, actor);
    task.archive("APP-6", actor);
    const before = snapshot();
    const refusals: Array<TaskOrderManyInput> = [
      { taskKeys: ["APP-4", "APP-99"], direction: "top" },
      { taskKeys: ["APP-4", "not-a-key"], direction: "top" },
      { taskKeys: ["APP-4", "OTHER-1"], direction: "top" },
      { taskKeys: ["APP-4", "APP-5"], direction: "top" },
      { taskKeys: ["APP-4", "APP-6"], direction: "top" },
      { taskKeys: ["APP-4", "app-4"], direction: "top" },
      { taskKeys: ["APP-4", "APP-2"], direction: "before", targetTaskKey: "app-2" },
      { taskKeys: ["APP-4", "APP-2"], direction: "after", targetTaskKey: "APP-4" },
      { taskKeys: ["APP-4", "APP-2"], direction: "before", targetTaskKey: "APP-99" },
      { taskKeys: ["APP-4", "APP-2"], direction: "after", targetTaskKey: "APP-6" },
      { taskKeys: ["APP-4", "APP-2"], direction: "before", targetTaskKey: "OTHER-1" },
      { taskKeys: ["APP-4", "APP-2"], direction: "after", targetTaskKey: "APP-5" },
      { taskKeys: ["APP-4", "APP-2"], direction: "up" },
      { taskKeys: ["APP-4", "APP-2"], direction: "down" },
      { taskKeys: [], direction: "top" },
    ];
    for (const props of refusals) {
      assert.throws(() => task.orderMany(props, actor), CoreError);
      assert.deepEqual(snapshot(), before);
    }
  });
});

test("an error after the first batch order rolls back task updates and history", () => {
  withTestStore(() => {
    seed();
    const before = snapshot();
    const update = dbTask.update;
    let calls = 0;
    const failure = new Error("write failed");
    const mocked = spyOn(dbTask, "update").mockImplementation((input) => {
      calls++;
      if (calls === 2) {
        throw failure;
      }
      return update(input);
    });
    try {
      assert.throws(() => task.orderMany({ taskKeys: ["APP-4", "APP-2"], direction: "top" }, actor), error => error === failure);
      assert.equal(calls, 2);
      assert.deepEqual(snapshot(), before);
    } finally {
      mocked.mockRestore();
    }
  });
});
