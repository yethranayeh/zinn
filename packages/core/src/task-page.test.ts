import { expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";

import { column, label, project, task } from "../index.js";
import type { TaskPageInput, TaskWithKey } from "../index.js";
import { getDb } from "./db.js";
import { MAX_LIST_LIMIT } from "./schemas/integer.js";
import { Statement } from "./sqlite/database.js";
import { withTestStore } from "./testing.js";

const actor = { name: "Task pages", email: null, kind: "human" as const };
const LARGE_DESCRIPTION_LENGTH = 16_384;
const LARGE_DESCRIPTION = "x".repeat(LARGE_DESCRIPTION_LENGTH);
const SELECTED_ACTIVITY_TIMESTAMPS = [100, 200, 300] as const;

function walkPages(input: TaskPageInput, expected: Array<TaskWithKey>, limit = 2) {
  const { startingAfter: _startingAfter, ...selection } = input;
  const collected: Array<TaskWithKey> = [];
  let startingAfter: string | undefined;

  do {
    const page = task.getPage({ ...selection, limit, startingAfter });
    const nextTasks = expected.slice(collected.length, collected.length + limit);
    expect(page.tasks).toEqual(nextTasks);
    collected.push(...page.tasks);
    expect(page.hasMore).toBe(collected.length < expected.length);
    expect(typeof page.nextCursor).toBe(page.hasMore ? "string" : "undefined");

    if (!page.hasMore) {
      break;
    }

    startingAfter = page.nextCursor;
  } while (collected.length <= expected.length);

  expect(collected).toEqual(expected);
}

function isTaskPayload(
  row: unknown,
): row is { id: string | null; project_id: string | null; task_order: string | null; title: string | null } {
  return (
    row !== null &&
    typeof row === "object" &&
    "id" in row &&
    "project_id" in row &&
    "task_order" in row &&
    "title" in row &&
    row.id !== null
  );
}

test("task pages match list order across board, due and activity keys including null board positions", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    label.create({ name: "selected" }, actor);
    column.create({ projectKey: app.key, name: "Kelvin", category: "todo" }, actor);
    column.create({ projectKey: other.key, name: "Kelvin", category: "todo" }, actor);

    const create = (
      projectId: string,
      title: string,
      dueAt: number | null,
      columnName?: string,
      selected = true,
    ) =>
      task.create(
        {
          project_id: projectId,
          title,
          due_at: dueAt,
          columnName,
          labelNames: selected ? ["selected"] : [],
        },
        actor,
      );

    const first = create(app.id, "First", 0, undefined, true);
    const dated = create(app.id, "Dated", -2, "Kelvin", true);
    const undated = create(app.id, "Undated", null, "Done", true);
    create(app.id, "Unselected", -10, "Done", false);
    const otherTask = create(other.id, "Other project", 0, "Kelvin", true);
    const archived = create(app.id, "Archived", -5, undefined, true);
    task.archive(archived.key, actor);

    getDb()
      .query("UPDATE activity SET created_at = CASE entity_id WHEN ? THEN 500 WHEN ? THEN 500 WHEN ? THEN 100 WHEN ? THEN 500 ELSE 50 END WHERE entity_type = 'task'")
      .run(first.id, dated.id, undated.id, otherTask.id);
    getDb().query("UPDATE task SET updated_at = 400 WHERE id = ?").run(undated.id);
    getDb().query("DELETE FROM activity WHERE entity_type = 'task' AND entity_id = ?").run(undated.id);

    const selector = {
      projectKey: app.key,
      archive: "all" as const,
      labelNames: ["SELECTED"],
    };
    for (const sort of [undefined, "due", "activity"] as const) {
      const input: TaskPageInput = { ...selector, sort };
      const expected = task.getAll(input);
      walkPages(input, expected, 1);
      walkPages(input, expected, 2);
      walkPages(input, expected, expected.length);
      expect(task.getPage(input)).toEqual({ tasks: expected, hasMore: false });
      expect(task.getPage({ ...input, limit: MAX_LIST_LIMIT })).toEqual({
        tasks: expected,
        hasMore: false,
      });

      if (expected.length > 1) {
        const beforeLast = task.getPage({ ...input, limit: expected.length - 1 });
        expect(beforeLast.hasMore).toBe(true);
        expect(task.getPage({ ...input, startingAfter: beforeLast.nextCursor })).toEqual({
          tasks: expected.slice(-1),
          hasMore: false,
        });
      }
    }

    const unicodeColumnSelection: TaskPageInput = {
      columnName: "kelvin",
      labelNames: ["selected"],
    };
    for (const sort of [undefined, "due", "activity"] as const) {
      const input = { ...unicodeColumnSelection, sort };
      walkPages(input, task.getAll(input), 1);
    }

    for (const archive of ["active", "archived", "all"] as const) {
      for (const sort of [undefined, "due", "activity"] as const) {
        const input: TaskPageInput = {
          archive,
          labelNames: ["selected", "SELECTED"],
          sort,
        };
        walkPages(input, task.getAll(input), 1);
      }
    }

    getDb().query("UPDATE project_column SET column_order = NULL WHERE id = (SELECT column_id FROM task WHERE id = ?)").run(dated.id);
    getDb().query("UPDATE task SET task_order = NULL WHERE id = ?").run(first.id);
    getDb().query("UPDATE task SET task_order = '' WHERE id = ?").run(dated.id);
    for (const sort of [undefined, "due", "activity"] as const) {
      const input: TaskPageInput = { ...selector, sort };
      walkPages(input, task.getAll(input), 1);
    }
  });
});

test("task pages continue from the cursor position and bound full rows under query_only", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    label.create({ name: "selected" }, actor);
    const selected = [
      task.create({ project_id: app.id, title: "Selected first", description: LARGE_DESCRIPTION, due_at: 0, labelNames: ["selected"], columnName: "Done" }, actor),
      task.create({ project_id: app.id, title: "Selected second", due_at: 0, labelNames: ["selected"], columnName: "Done" }, actor),
      task.create({ project_id: app.id, title: "Selected third", due_at: 0, labelNames: ["selected"], columnName: "Done" }, actor),
    ];
    for (let index = 0; index < 12; index++) {
      task.create({
        project_id: app.id,
        title: `Sparse row ${index}`,
        description: LARGE_DESCRIPTION,
        due_at: 0,
        columnName: "Done",
      }, actor);
    }
    getDb()
      .query("UPDATE activity SET created_at = CASE entity_id WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? END WHERE entity_type = 'task' AND entity_id IN (?, ?, ?)")
      .run(
        selected[0]!.id,
        SELECTED_ACTIVITY_TIMESTAMPS[0],
        selected[1]!.id,
        SELECTED_ACTIVITY_TIMESTAMPS[1],
        selected[2]!.id,
        SELECTED_ACTIVITY_TIMESTAMPS[2],
        selected[0]!.id,
        selected[1]!.id,
        selected[2]!.id,
      );
    const input: TaskPageInput = {
      projectKey: app.key,
      labelNames: ["selected"],
      columnName: "Done",
      dueSince: 0,
      dueUntil: 0,
      sort: "activity",
      limit: 1,
    };
    const beforeTasks = getDb().query("SELECT * FROM task ORDER BY id").all();
    const beforeActivity = getDb().query("SELECT * FROM activity ORDER BY id").all();
    const fullTaskRows: Array<number> = [];
    const statementPrototype = Statement.prototype as unknown as {
      all(...params: Array<unknown>): Array<unknown>;
    };
    const originalAll = statementPrototype.all;
    const reader = spyOn(statementPrototype, "all").mockImplementation(function (
      this: { all(...params: Array<unknown>): Array<unknown> },
      ...params: Array<unknown>
    ) {
      const rows = originalAll.apply(this, params);
      const payloadRows = rows.filter(isTaskPayload);
      if (payloadRows.length > 0) {
        fullTaskRows.push(payloadRows.length);
      }
      return rows;
    });

    let firstPage: ReturnType<typeof task.getPage>;
    let secondPage: ReturnType<typeof task.getPage>;
    try {
      getDb().exec("PRAGMA query_only = ON");
      firstPage = task.getPage(input);
      expect(firstPage).toMatchObject({ tasks: [selected[2]!], hasMore: true });
      secondPage = task.getPage({ ...input, startingAfter: firstPage.nextCursor });
      expect(secondPage).toMatchObject({ tasks: [selected[1]!], hasMore: true });
      const thirdPage = task.getPage({ ...input, startingAfter: secondPage.nextCursor });
      expect(thirdPage).toEqual({ tasks: [selected[0]!], hasMore: false });
    } finally {
      reader.mockRestore();
    }
    expect(fullTaskRows).toEqual([2, 2, 1]);
    expect(getDb().query<{ query_only: number }>("PRAGMA query_only").get()?.query_only).toBe(1);
    expect(getDb().query("SELECT * FROM task ORDER BY id").all()).toEqual(beforeTasks);
    expect(getDb().query("SELECT * FROM activity ORDER BY id").all()).toEqual(beforeActivity);

    getDb().exec("PRAGMA query_only = OFF");
    const selectedFirstPage = task.getPage({ projectKey: app.key, limit: 1 });
    task.order({ taskKey: selected[2]!.key, direction: "top" }, actor);
    task.move({ taskKey: selected[1]!.key, targetColumn: "Backlog" }, actor);
    const liveContinuation = task.getPage({
      projectKey: app.key,
      limit: 1,
      startingAfter: selectedFirstPage.nextCursor,
    });
    const continuationIds = liveContinuation.tasks.map(({ id }) => id);
    expect(continuationIds).not.toContain(selected[2]!.id);
    expect(continuationIds).not.toContain(selected[1]!.id);
  });
});

test("activity-sorted cursors keep their recorded time when event times change", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const earlier = task.create({ project_id: app.id, title: "Earlier" }, actor);
    const later = task.create({ project_id: app.id, title: "Later" }, actor);
    getDb()
      .query("UPDATE activity SET created_at = CASE entity_id WHEN ? THEN 100 WHEN ? THEN 200 END WHERE entity_type = 'task' AND entity_id IN (?, ?)")
      .run(earlier.id, later.id, earlier.id, later.id);

    const firstPage = task.getPage({ sort: "activity", limit: 1 });
    expect(firstPage).toMatchObject({ tasks: [later], hasMore: true });
    getDb()
      .query("UPDATE activity SET created_at = 300 WHERE entity_type = 'task' AND entity_id = ?")
      .run(earlier.id);
    expect(task.getPage({ sort: "activity", limit: 1, startingAfter: firstPage.nextCursor })).toEqual({
      tasks: [],
      hasMore: false,
    });
  });
});

function keys(tasks: Array<TaskWithKey>) {
  return tasks.map(({ key }) => key);
}

test("ZINN-464: cursors continue after the recorded position when the last task changes", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    label.create({ name: "selected" }, actor);
    for (let index = 1; index <= 4; index++) {
      task.create({ project_id: app.id, title: `Task ${index}`, due_at: index, labelNames: ["selected"] }, actor);
    }
    getDb()
      .query("UPDATE activity SET created_at = 1000 - (SELECT number FROM task WHERE task.id = entity_id) * 100 WHERE entity_type = 'task'")
      .run();

    // Editing the last task under activity order moves it to the top without repeating tasks.
    const activityPage = task.getPage({ projectKey: app.key, sort: "activity", limit: 2 });
    expect(keys(activityPage.tasks)).toEqual(["APP-1", "APP-2"]);
    task.edit({ taskKey: "APP-2", title: "Edited" }, actor);
    expect(keys(task.getAll({ projectKey: app.key, sort: "activity" }))[0]).toBe("APP-2");
    expect(keys(task.getPage({
      projectKey: app.key,
      sort: "activity",
      startingAfter: activityPage.nextCursor,
    }).tasks)).toEqual(["APP-3", "APP-4"]);

    const continueAfterChange = (
      selection: TaskPageInput,
      change: (taskKey: string) => void,
      expected: Array<string>,
    ) => {
      const page = task.getPage({ ...selection, limit: 1 });
      expect(keys(page.tasks)).toEqual(["APP-1"]);
      change("APP-1");
      expect(keys(task.getPage({ ...selection, startingAfter: page.nextCursor }).tasks)).toEqual(expected);
    };

    const rest = ["APP-2", "APP-3", "APP-4"];
    continueAfterChange(
      { projectKey: app.key, columnName: "Backlog" },
      (taskKey) => task.move({ taskKey, targetColumn: "Done" }, actor),
      rest,
    );
    task.move({ taskKey: "APP-1", targetColumn: "Backlog" }, actor);
    task.order({ taskKey: "APP-1", direction: "top" }, actor);
    continueAfterChange(
      { projectKey: app.key, labelNames: ["selected"] },
      (taskKey) => task.label.remove({ taskKey, labelNames: ["selected"] }, actor),
      rest,
    );
    continueAfterChange(
      { projectKey: app.key, sort: "due", dueUntil: 10 },
      (taskKey) => task.edit({ taskKey, due_at: 20 }, actor),
      rest,
    );
    continueAfterChange(
      { projectKey: app.key },
      (taskKey) => task.archive(taskKey, actor),
      rest,
    );
    task.unarchive("APP-1", actor);
    task.order({ taskKey: "APP-1", direction: "top" }, actor);
    continueAfterChange(
      { projectKey: app.key },
      (taskKey) => task.delete(taskKey, actor),
      rest,
    );
  });
});

test("ZINN-464: tasks that tie on every board key keep one order across pages", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const created = [1, 2, 3, 4].map((index) =>
      task.create({ project_id: app.id, title: `Tie ${index}` }, actor),
    );
    getDb().query("UPDATE task SET number = 1, task_order = 'a0' WHERE project_id = ?").run(app.id);
    getDb().query("UPDATE activity SET created_at = 100 WHERE entity_type = 'task'").run();

    for (const sort of [undefined, "due", "activity"] as const) {
      const expected = task.getAll({ sort });
      expect(expected.map(({ id }) => id)).toEqual(created.map(({ id }) => id).sort());
      walkPages({ sort }, expected, 1);
      walkPages({ sort }, expected, 3);
    }
  });
});

test("ZINN-464: task cursors refuse malformed, other-version, other-sort and task-ID values", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    label.create({ name: "selected" }, actor);
    const first = task.create({ project_id: app.id, title: "First", labelNames: ["selected"] }, actor);
    task.create({ project_id: app.id, title: "Second", labelNames: ["selected"] }, actor);
    task.create({ project_id: app.id, title: "Third" }, actor);
    const boardCursor = task.getPage({ projectKey: app.key, limit: 1 }).nextCursor!;
    const dueCursor = task.getPage({ projectKey: app.key, sort: "due", limit: 1 }).nextCursor!;
    expect(boardCursor).toMatch(/^[^-]/);

    // Filters may change under the same sort.
    expect(keys(task.getPage({ labelNames: ["selected"], startingAfter: boardCursor }).tasks)).toEqual(["APP-2"]);

    const [marker, payload] = boardCursor.split(".") as [string, string];
    const version = marker.replace(/^\D+/, "");
    const markerName = marker.slice(0, marker.length - version.length);
    const encode = (value: unknown) => `${marker}.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Array<unknown>;
    const refusals: Array<[string, TaskPageInput]> = [
      ["invalid_cursor", { startingAfter: "" }],
      ["invalid_cursor", { startingAfter: "APP-1" }],
      ["invalid_cursor", { startingAfter: "abcdef1" }],
      ["invalid_cursor", { startingAfter: `${marker}.not*base64` }],
      ["invalid_cursor", { startingAfter: `${marker}.${Buffer.from("{").toString("base64url")}` }],
      ["invalid_cursor", { startingAfter: encode(decoded.slice(0, -1)) }],
      ["invalid_cursor", { startingAfter: encode([...decoded, "extra"]) }],
      ["invalid_cursor", { startingAfter: encode(["unknown", ...decoded.slice(1)]) }],
      ["invalid_cursor", { startingAfter: encode(decoded.map((value) => (typeof value === "number" ? String(value) : value))) }],
      ["cursor_version", { startingAfter: `${markerName}${Number(version) + 1}.${payload}` }],
      ["different_sort", { sort: "due", startingAfter: boardCursor }],
      ["different_sort", { sort: "activity", startingAfter: boardCursor }],
      ["different_sort", { startingAfter: dueCursor }],
      ["task_id_cursor", { startingAfter: first.id }],
      ["task_id_cursor", { startingAfter: first.id.replaceAll("-", "").toUpperCase() }],
      ["task_id_cursor", { startingAfter: first.id.slice(0, 8) }],
    ];
    for (const [reason, input] of refusals) {
      expect(() => task.getPage({ projectKey: app.key, ...input })).toThrow(
        expect.objectContaining({
          kind: "input",
          facts: { field: ["startingAfter"], reason },
        }),
      );
    }
  });
});
