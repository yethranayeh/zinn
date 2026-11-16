import { afterEach, expect, setSystemTime, test } from "bun:test";

import { column, project, relation, task } from "../index.js";
import type { Actor, TaskCreateInput } from "../index.js";
import { getDb, resetDatabaseForTests } from "./db.js";
import { TASK_CLAIM_VERSION } from "./migrations/task-claim.js";
import { CLAIM_WORK_LIMIT_MS } from "./schemas/task.js";
import { removeColumnCategories, withTestHome, withTestStore } from "./testing.js";

const actor = { name: "Task next", email: null, kind: "human" as const };
const holder: Actor = { name: "Agent", email: null, kind: "agent", sessionId: "session-a" };
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 10, 1);
const MINUTE_MS = 60_000;
const LEASE_MS = 30 * MINUTE_MS;

afterEach(() => {
  setSystemTime();
});

function at(time: number) {
  setSystemTime(new Date(time));
}

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

    expect(task.next({ projectKey: other.key })?.key).toBe(blocked.key);
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
  withTestHome(() => {
    const app = project.create({ key: "APP" }, actor);
    createTask(app.id, "Last column", { priority: "urgent", columnName: "Cancelled" });
    const done = createTask(app.id, "Done", { priority: "high", columnName: "Done" });
    removeColumnCategories();

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

test("task next hands out todo and backlog tasks only, unless a column is named", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const doing = createTask(app.id, "Doing", { priority: "urgent", columnName: "Doing" });
    const review = createTask(app.id, "Review", { priority: "urgent", columnName: "Review" });

    expect(task.next()).toBeNull();
    expect(task.next({ columnName: "Doing" })?.key).toBe(doing.key);
    expect(task.next({ columnName: "Review" })?.key).toBe(review.key);

    const backlog = createTask(app.id, "Backlog", { priority: "low" });
    expect(task.next()?.key).toBe(backlog.key);
  });
});

test("task next hands out todo tasks before backlog tasks, whatever their priority", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const urgentBacklog = createTask(app.id, "Urgent backlog", { priority: "urgent" });
    const lowTodo = createTask(app.id, "Low todo", { priority: "low", columnName: "TODO" });
    const blocker = createTask(app.id, "Blocker", { columnName: "Doing" });

    expect(task.next()?.key).toBe(lowTodo.key);

    // Backlog stays eligible when no todo task is ready.
    dependOn(lowTodo.key, blocker.key);
    expect(task.next()?.key).toBe(urgentBacklog.key);
  });
});

test("task next reads ready columns from their category, not their name or position", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    column.edit({ projectKey: app.key, columnName: "TODO", name: "Committed" }, actor);
    column.order({ projectKey: app.key, columnName: "Committed", direction: "last" }, actor);
    column.edit({ projectKey: app.key, columnName: "Doing", category: "backlog" }, actor);
    column.edit({ projectKey: app.key, columnName: "Backlog", category: "in_progress" }, actor);
    createTask(app.id, "Started", { priority: "urgent" });
    const parked = createTask(app.id, "Parked", { priority: "high", columnName: "Doing" });
    const committed = createTask(app.id, "Committed", { priority: "low", columnName: "Committed" });

    expect(task.next()?.key).toBe(committed.key);

    task.archive(committed.key, actor);
    expect(task.next()?.key).toBe(parked.key);
  });
});

test("task next hands out tasks from every column but the last on an older schema without categories", () => {
  withTestHome(() => {
    const app = project.create({ key: "APP" }, actor);
    createTask(app.id, "Backlog", { priority: "low" });
    const review = createTask(app.id, "Review", { priority: "urgent", columnName: "Review" });
    removeColumnCategories();

    expect(task.next()?.key).toBe(review.key);
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

test("ZINN-586: task next skips a task with a live claim, with and without a column, and returns it once the lease ran out", () => {
  withTestStore(() => {
    at(START);
    const app = project.create({ key: "APP" }, actor);
    const claimed = createTask(app.id, "Claimed", { priority: "urgent" });
    const following = createTask(app.id, "Following", { priority: "low" });
    task.claim({ taskKey: claimed.key, leaseMs: LEASE_MS }, holder);

    expect(task.next()?.key).toBe(following.key);
    expect(task.next({ projectKey: app.key, columnName: "Backlog" })?.key).toBe(following.key);

    task.archive(following.key, actor);
    expect(task.next()).toBeNull();
    expect(task.next({ columnName: "Backlog" })).toBeNull();

    at(START + LEASE_MS - 1);
    expect(task.next()).toBeNull();

    at(START + LEASE_MS);
    expect(task.next()).toMatchObject({ key: claimed.key, claim: { state: "expired" } });
    expect(task.next({ columnName: "Backlog" })?.key).toBe(claimed.key);
  });
});

test("ZINN-586: task next returns a claimed task once a day passed since the holder's last work, whatever the lease", () => {
  withTestStore(() => {
    at(START);
    const app = project.create({ key: "APP" }, actor);
    const claimed = createTask(app.id, "Claimed");
    task.claim({ taskKey: claimed.key, leaseMs: LEASE_MS }, holder);

    // Heartbeats keep the lease running but are not work.
    for (let time = START; time < START + CLAIM_WORK_LIMIT_MS; time += LEASE_MS / 2) {
      at(time);
      task.heartbeat(claimed.key, holder);
      expect(task.next()).toBeNull();
    }

    at(START + CLAIM_WORK_LIMIT_MS);
    expect(task.next()?.key).toBe(claimed.key);
    expect(task.next({ columnName: "Backlog" })?.key).toBe(claimed.key);
  });
});

test("ZINN-586: task next on an in-progress column returns only work with no live claim", () => {
  withTestStore(() => {
    at(START);
    const app = project.create({ key: "APP" }, actor);
    const live = createTask(app.id, "Live", { priority: "urgent", columnName: "Doing" });
    const abandoned = createTask(app.id, "Abandoned", { priority: "high", columnName: "Doing" });
    const unclaimed = createTask(app.id, "Never claimed", { priority: "low", columnName: "Doing" });
    task.claim({ taskKey: live.key, leaseMs: LEASE_MS }, holder);
    task.claim({ taskKey: abandoned.key, leaseMs: LEASE_MS }, holder);
    const inProgress = { projectKey: app.key, columnName: "Doing" };

    expect(task.next()).toBeNull();
    expect(task.next(inProgress)?.key).toBe(unclaimed.key);

    at(START + 2 * LEASE_MS);
    task.claim({ taskKey: live.key, leaseMs: LEASE_MS }, holder);
    expect(task.next(inProgress)).toMatchObject({ key: abandoned.key, claim: { state: "expired" } });

    task.claim({ taskKey: abandoned.key, leaseMs: LEASE_MS }, actor);
    expect(task.next(inProgress)?.key).toBe(unclaimed.key);
  });
});

test("ZINN-586: task next skips the caller's own live claim too", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, holder);
    const own = createTask(app.id, "Own", { priority: "urgent" });
    task.claim({ taskKey: own.key, leaseMs: LEASE_MS }, holder);

    expect(task.next()).toBeNull();
    expect(task.next({ projectKey: app.key, columnName: "Backlog" })).toBeNull();
  });
});

test("ZINN-586: task next answers on an older schema without claims", () => {
  withTestHome(() => {
    const app = project.create({ key: "APP" }, actor);
    const claimed = createTask(app.id, "Claimed", { priority: "urgent", columnName: "Doing" });
    task.claim({ taskKey: claimed.key, leaseMs: LEASE_MS }, holder);
    getDb().exec("DROP TABLE task_claim");
    getDb().exec(`PRAGMA user_version = ${TASK_CLAIM_VERSION - 1}`);
    resetDatabaseForTests();

    expect(task.next({ columnName: "Doing" })).toMatchObject({ key: claimed.key, claim: null });
    expect(task.next()).toBeNull();
  });
});
