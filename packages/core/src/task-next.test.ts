import { expect, test } from "bun:test";

import { column, project, relation, task } from "../index.js";
import type { TaskCreateInput } from "../index.js";
import { getDb } from "./db.js";
import { withTestStore } from "./testing.js";

const actor = { name: "Task next", email: null, kind: "human" as const };
const DAY_MS = 86_400_000;

function createTask(projectId: string, title: string, fields: Partial<TaskCreateInput> = {}) {
  return task.create({ project_id: projectId, title, description: "", ...fields }, actor);
}

function dependOn(sourceTaskKey: string, targetTaskKey: string) {
  relation.create({ sourceTaskKey, targetTaskKey, relation_type: "dependency" }, actor);
}

function setCreatedAt(taskId: string, createdAt: number) {
  getDb().query("UPDATE task SET created_at = ? WHERE id = ?").run(createdAt, taskId);
}

test("task next returns null when no task is ready", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);

    expect(task.next()).toBeNull();
    expect(task.next({ projectKey: app.key })).toBeNull();
  });
});

test("task next skips archived tasks and tasks in done and cancelled columns", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const archived = createTask(app.id, "Archived", { priority: "urgent" });
    createTask(app.id, "Finished", { priority: "urgent", columnName: "Done" });
    createTask(app.id, "Dropped", { priority: "urgent", columnName: "Cancelled" });
    const open = createTask(app.id, "Open", { priority: "low" });
    task.archive(archived.key, actor);

    expect(task.next()?.key).toBe(open.key);
  });
});

test("task next releases a dependency once its target is archived, done or cancelled", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const blocked = createTask(app.id, "Blocked", { priority: "urgent" });
    const firstTarget = createTask(app.id, "First target", { priority: "high" });
    const secondTarget = createTask(app.id, "Second target", { priority: "medium" });
    const thirdTarget = createTask(app.id, "Third target");
    dependOn(blocked.key, firstTarget.key);
    dependOn(blocked.key, secondTarget.key);
    dependOn(blocked.key, thirdTarget.key);

    expect(task.next()?.key).toBe(firstTarget.key);

    task.archive(firstTarget.key, actor);
    expect(task.next()?.key).toBe(secondTarget.key);

    task.move({ taskKey: secondTarget.key, targetColumn: "Done" }, actor);
    expect(task.next()?.key).toBe(thirdTarget.key);

    task.move({ taskKey: thirdTarget.key, targetColumn: "Cancelled" }, actor);
    expect(task.next()?.key).toBe(blocked.key);
  });
});

test("task next ignores relations other than dependency", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const source = createTask(app.id, "Source", { priority: "urgent" });

    for (const relationType of ["related", "duplicate", "subtask"] as const) {
      const target = createTask(app.id, `${relationType} target`);
      relation.create(
        { sourceTaskKey: source.key, targetTaskKey: target.key, relation_type: relationType },
        actor,
      );
    }

    expect(task.next()?.key).toBe(source.key);
  });
});

test("task next blocks every task in a dependency cycle", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const first = createTask(app.id, "First", { priority: "urgent" });
    const second = createTask(app.id, "Second", { priority: "urgent" });
    const third = createTask(app.id, "Third", { priority: "urgent" });
    dependOn(first.key, second.key);
    dependOn(second.key, third.key);
    dependOn(third.key, first.key);

    expect(task.next()).toBeNull();
  });
});

test("task next reads closed columns from their category, not their name or position", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    column.edit({ projectKey: app.key, columnName: "Done", name: "Shipped" }, actor);
    column.order({ projectKey: app.key, columnName: "Shipped", direction: "first" }, actor);
    column.create({ projectKey: app.key, name: "Finished", category: "todo" }, actor);
    const shipped = createTask(app.id, "Shipped", { priority: "urgent", columnName: "Shipped" });
    const finished = createTask(app.id, "Finished", { columnName: "Finished" });
    const blocked = createTask(other.id, "Blocked", { priority: "high" });
    dependOn(blocked.key, shipped.key);

    expect(task.next()?.key).toBe(blocked.key);
    expect(task.next({ projectKey: app.key })?.key).toBe(finished.key);
  });
});

test("task next treats every task as open on a board without done or cancelled columns", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    for (const columnName of ["TODO", "Doing", "Review", "Done", "Cancelled"]) {
      column.delete({ projectKey: app.key, columnName }, actor);
    }
    const only = createTask(app.id, "Only column");

    expect(task.next()?.key).toBe(only.key);
  });
});

test("task next counts the last column as closed on an older schema without categories", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    createTask(app.id, "Last column", { priority: "urgent", columnName: "Cancelled" });
    const done = createTask(app.id, "Done", { priority: "high", columnName: "Done" });
    getDb().exec("ALTER TABLE project_column DROP COLUMN category");

    expect(task.next()?.key).toBe(done.key);
  });
});

test("task next orders by priority, then deadline, then creation", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    const now = Date.now();

    createTask(app.id, "Unset priority");
    const low = createTask(app.id, "Low", { priority: "low" });
    expect(task.next()?.key).toBe(low.key);

    const undatedHigh = createTask(app.id, "Undated high", { priority: "high" });
    const laterHigh = createTask(app.id, "Later high", { priority: "high", due_at: now + DAY_MS });
    const earlierHigh = createTask(app.id, "Earlier high", { priority: "high", due_at: now });
    expect(task.next()?.key).toBe(earlierHigh.key);

    task.archive(earlierHigh.key, actor);
    expect(task.next()?.key).toBe(laterHigh.key);

    task.archive(laterHigh.key, actor);
    // An older task in a later project key comes first.
    const olderHigh = createTask(other.id, "Older high", { priority: "high" });
    setCreatedAt(olderHigh.id, 0);
    expect(task.next()?.key).toBe(olderHigh.key);
    expect(task.next({ projectKey: app.key })?.key).toBe(undatedHigh.key);

    const urgent = createTask(app.id, "Urgent", { priority: "urgent", due_at: now + DAY_MS });
    expect(task.next()?.key).toBe(urgent.key);
  });
});

test("task next limits ready tasks to one column by name, ignoring case", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    createTask(app.id, "Backlog task", { priority: "urgent" });
    const todo = createTask(app.id, "TODO task", { columnName: "TODO" });
    const otherTodo = createTask(other.id, "Other TODO task", { priority: "low", columnName: "TODO" });

    expect(task.next({ columnName: "todo" })?.key).toBe(otherTodo.key);
    expect(task.next({ projectKey: app.key, columnName: "todo" })?.key).toBe(todo.key);
    expect(task.next({ columnName: "Missing" })).toBeNull();
    expect(task.next({ columnName: "Done" })).toBeNull();
  });
});

test("task next rejects an unknown project", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);

    let failure: unknown;
    try {
      task.next({ projectKey: "NOPE" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "missing", facts: { entity: "project", key: "NOPE" } });
  });
});
