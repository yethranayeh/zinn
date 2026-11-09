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

test("task next skips archived tasks and tasks in the last column", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const archived = createTask(app.id, "Archived", { priority: "urgent" });
    createTask(app.id, "Finished", { priority: "urgent", columnName: "Done" });
    const open = createTask(app.id, "Open", { priority: "low" });
    task.archive(archived.key, actor);

    expect(task.next()?.key).toBe(open.key);
  });
});

test("task next releases a dependency once its target is archived or in the last column", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const blocked = createTask(app.id, "Blocked", { priority: "urgent" });
    const firstTarget = createTask(app.id, "First target");
    const secondTarget = createTask(app.id, "Second target");
    dependOn(blocked.key, firstTarget.key);
    dependOn(blocked.key, secondTarget.key);

    expect(task.next()?.key).toBe(firstTarget.key);

    task.archive(firstTarget.key, actor);
    expect(task.next()?.key).toBe(secondTarget.key);

    task.move({ taskKey: secondTarget.key, targetColumn: "Done" }, actor);
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

test("task next tests a cross-project dependency against the target's own board", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    column.create({ projectKey: app.key, name: "Shipped" }, actor);
    const blocked = createTask(app.id, "Blocked");
    // Done is the last column on OTHER's board but not on APP's.
    const target = createTask(other.id, "Target", { columnName: "Done" });
    dependOn(blocked.key, target.key);

    expect(task.next({ projectKey: app.key })?.key).toBe(blocked.key);
  });
});

test("task next finds nothing ready on a single-column board", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    for (const columnName of ["TODO", "In Progress", "Review", "Done"]) {
      column.delete({ projectKey: app.key, columnName }, actor);
    }
    createTask(app.id, "Only column");

    expect(column.getAllByProjectKey(app.key)).toHaveLength(1);
    expect(task.next()).toBeNull();
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
