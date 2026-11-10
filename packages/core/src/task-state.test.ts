import { expect, test } from "bun:test";

import { column, project, task } from "../index.js";
import type { TaskCreateInput } from "../index.js";
import { getDb } from "./db.js";
import { withTestStore } from "./testing.js";

const actor = { name: "Task state", email: null, kind: "human" as const };

function createTask(projectId: string, title: string, fields: Partial<TaskCreateInput> = {}) {
  return task.create({ project_id: projectId, title, description: "", ...fields }, actor);
}

function keysOf(tasks: Array<{ key: string }>) {
  return tasks.map(({ key }) => key);
}

/** One open task per open category, one done and one cancelled task, and an archived done task. */
function createBoard() {
  const app = project.create({ key: "APP" }, actor);
  const backlog = createTask(app.id, "Backlog");
  const todo = createTask(app.id, "Todo", { columnName: "TODO" });
  const doing = createTask(app.id, "Doing", { columnName: "Doing" });
  const review = createTask(app.id, "Review", { columnName: "Review" });
  const done = createTask(app.id, "Done", { columnName: "Done" });
  const cancelled = createTask(app.id, "Cancelled", { columnName: "Cancelled" });
  const archivedDone = createTask(app.id, "Archived done", { columnName: "Done" });
  task.archive(archivedDone.key, actor);

  return {
    app,
    open: keysOf([backlog, todo, doing, review]),
    closed: keysOf([done, cancelled]),
    archivedDone: archivedDone.key,
  };
}

test("task lists show open tasks by default and closed tasks on request", () => {
  withTestStore(() => {
    const board = createBoard();

    expect(keysOf(task.getAll())).toEqual(board.open);
    expect(keysOf(task.getAll({ state: "open" }))).toEqual(board.open);
    expect(keysOf(task.getAll({ state: "closed" }))).toEqual(board.closed);
    expect(keysOf(task.getAll({ state: "all" }))).toEqual([...board.open, ...board.closed]);
    expect(keysOf(task.getPage().tasks)).toEqual(board.open);
  });
});

test("the state filter combines with the archive filter", () => {
  withTestStore(() => {
    const board = createBoard();

    expect(keysOf(task.getAll({ archive: "archived" }))).toEqual([]);
    expect(keysOf(task.getAll({ archive: "archived", state: "closed" }))).toEqual([
      board.archivedDone,
    ]);
    expect(keysOf(task.getAll({ archive: "all", state: "closed" }))).toContain(board.archivedDone);
    expect(task.getAll({ archive: "all", state: "all" })).toHaveLength(
      board.open.length + board.closed.length + 1,
    );
  });
});

test("task pages count the closed tasks that the default state hides", () => {
  withTestStore(() => {
    const board = createBoard();

    expect(task.getPage().hiddenClosedCount).toBe(board.closed.length);
    expect(task.getPage({ limit: 1 }).hiddenClosedCount).toBe(board.closed.length);
    expect(task.getPage({ columnName: "Done" })).toEqual({
      tasks: [],
      hasMore: false,
      hiddenClosedCount: 1,
    });
    expect(task.getPage({ archive: "all" }).hiddenClosedCount).toBe(board.closed.length + 1);
    expect(task.getPage({ columnName: "Doing" })).not.toHaveProperty("hiddenClosedCount");
    for (const state of ["open", "closed", "all"] as const) {
      expect(task.getPage({ state })).not.toHaveProperty("hiddenClosedCount");
    }
  });
});

test("task lists read closed columns from their category, not their name or position", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    column.edit({ projectKey: app.key, columnName: "Done", name: "Shipped" }, actor);
    column.order({ projectKey: app.key, columnName: "Shipped", direction: "first" }, actor);
    column.create({ projectKey: app.key, name: "Finished", category: "todo" }, actor);
    const shipped = createTask(app.id, "Shipped", { columnName: "Shipped" });
    const finished = createTask(app.id, "Finished", { columnName: "Finished" });

    expect(keysOf(task.getAll())).toEqual([finished.key]);
    expect(keysOf(task.getAll({ state: "closed" }))).toEqual([shipped.key]);
  });
});

test("task lists count the last column as closed on an older schema without categories", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const last = createTask(app.id, "Last column", { columnName: "Cancelled" });
    const done = createTask(app.id, "Done", { columnName: "Done" });
    getDb().exec("ALTER TABLE project_column DROP COLUMN category");

    expect(keysOf(task.getAll())).toEqual([done.key]);
    expect(keysOf(task.getAll({ state: "closed" }))).toEqual([last.key]);
    expect(task.getPage().hiddenClosedCount).toBe(1);
  });
});

test("task lists reject an unknown state", () => {
  withTestStore(() => {
    expect(() => task.getAll({ state: "done" as never })).toThrow();
  });
});
