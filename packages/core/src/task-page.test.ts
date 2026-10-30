import { expect, spyOn, test } from "bun:test";

import { column, label, project, task } from "../index.js";
import type { TaskPageInput, TaskWithKey } from "../index.js";
import { getDb } from "./db.js";
import * as dbTask from "./db/task.js";
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

    if (!page.hasMore) {
      break;
    }

    startingAfter = page.tasks.at(-1)!.id;
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
    column.create({ projectKey: app.key, name: "Kelvin" }, actor);
    column.create({ projectKey: other.key, name: "Kelvin" }, actor);

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

      if (expected.length > 0) {
        expect(
          task.getPage({
            ...input,
            startingAfter: expected.at(-1)!.id.toUpperCase().replaceAll("-", ""),
          }),
        ).toEqual({ tasks: [], hasMore: false });
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

test("task cursors resolve globally and require membership in the current filters, not the first limit", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    label.create({ name: "selected" }, actor);

    const first = task.create({ project_id: app.id, title: "First", due_at: 1, labelNames: ["selected"] }, actor);
    const second = task.create({ project_id: app.id, title: "Second", due_at: 2, labelNames: ["selected"] }, actor);
    const third = task.create({ project_id: app.id, title: "Third", due_at: 3, labelNames: ["selected"] }, actor);
    const unselected = task.create({ project_id: app.id, title: "Unselected", due_at: 1 }, actor);
    const differentProject = task.create({ project_id: other.id, title: "Other", due_at: 1 }, actor);
    const archived = task.create({ project_id: app.id, title: "Archived", due_at: 1 }, actor);
    task.archive(archived.key, actor);

    const afterSecond = task.getPage({ projectKey: app.key, labelNames: ["selected"], limit: 1, startingAfter: second.id });
    expect(afterSecond).toEqual({ tasks: [third], hasMore: false });

    const allIds = [first.id, second.id, third.id, unselected.id, differentProject.id, archived.id];
    const firstCompactId = first.id.replaceAll("-", "");
    let firstUniquePrefixLength = 8;
    while (
      allIds.filter((id) => id.replaceAll("-", "").startsWith(firstCompactId.slice(0, firstUniquePrefixLength)))
        .length > 1
    ) {
      firstUniquePrefixLength++;
    }
    const compactPrefix = firstCompactId.slice(0, firstUniquePrefixLength);
    expect(task.getPage({ startingAfter: second.id.toUpperCase().replaceAll("-", "") }).tasks)
      .toEqual(task.getAll().slice(2));
    expect(task.getPage({ startingAfter: compactPrefix.toUpperCase() }).tasks.map(({ id }) => id))
      .toEqual(task.getAll().slice(1).map(({ id }) => id));
    expect(task.getPage({ startingAfter: second.id.toUpperCase() }).tasks.map(({ id }) => id))
      .toEqual(task.getAll().slice(2).map(({ id }) => id));

    const errors = [
      { input: { projectKey: other.key }, cursor: first.id },
      { input: { projectKey: app.key, labelNames: ["selected"] }, cursor: unselected.id },
      { input: { projectKey: app.key, archive: "archived" as const }, cursor: first.id },
      { input: { projectKey: app.key, dueSince: 2 }, cursor: first.id },
      { input: { projectKey: app.key, dueUntil: 2 }, cursor: third.id },
      { input: { projectKey: app.key, columnName: "Done" }, cursor: first.id },
    ];
    for (const { input, cursor } of errors) {
      expect(() => task.getPage({ ...input, startingAfter: cursor })).toThrow(
        expect.objectContaining({
          kind: "input",
          facts: expect.objectContaining({ entity: "task", field: ["startingAfter"] }),
        }),
      );
    }

    task.archive(first.key, actor);
    expect(() => task.getPage({ projectKey: app.key, startingAfter: first.id })).toThrow(
      expect.objectContaining({
        kind: "input",
        facts: expect.objectContaining({ entity: "task", field: ["startingAfter"] }),
      }),
    );
    task.label.remove({ taskKey: second.key, labelNames: ["selected"] }, actor);
    expect(() => task.getPage({ projectKey: app.key, labelNames: ["selected"], startingAfter: second.id }))
      .toThrow(expect.objectContaining({
        kind: "input",
        facts: expect.objectContaining({ entity: "task", field: ["startingAfter"] }),
      }));
    task.edit({ taskKey: third.key, due_at: 10 }, actor);
    expect(() => task.getPage({
      projectKey: app.key,
      labelNames: ["selected"],
      dueSince: 0,
      dueUntil: 3,
      startingAfter: third.id,
    })).toThrow(expect.objectContaining({
      kind: "input",
      facts: expect.objectContaining({ entity: "task", field: ["startingAfter"] }),
    }));

    expect(() => task.getPage({ startingAfter: "ffffffff-ffff-7fff-8fff-ffffffffffff" })).toThrow(
      expect.objectContaining({
        kind: "missing",
        facts: expect.objectContaining({ entity: "task" }),
      }),
    );
    expect(() => task.getPage({
      projectKey: "MISSING",
      labelNames: ["unavailable"],
      startingAfter: "ffffffff-ffff-7fff-8fff-ffffffffffff",
    })).toThrow(
      expect.objectContaining({
        kind: "missing",
        facts: expect.objectContaining({ entity: "task" }),
      }),
    );
    expect(() => task.getPage({ startingAfter: first.key })).toThrow(
      expect.objectContaining({
        kind: "input",
        facts: expect.objectContaining({ field: ["startingAfter"] }),
      }),
    );

    const ambiguousLookup = spyOn(dbTask, "getByIdPrefix").mockReturnValue([
      { id: "12345678-0000-7000-8000-000000000001" },
      { id: "12345678-0000-7000-8000-000000000002" },
    ]);
    try {
      expect(() => task.getPage({ startingAfter: "12345678" })).toThrow(
        expect.objectContaining({
          kind: "conflict",
          facts: expect.objectContaining({
            entity: "task",
            reason: "ambiguous_reference",
            matchCount: 2,
            candidateIds: [
              "12345678-0000-7000-8000-000000000001",
              "12345678-0000-7000-8000-000000000002",
            ],
          }),
        }),
      );
    } finally {
      ambiguousLookup.mockRestore();
    }
  });
});

test("task pages follow the cursor's live position and bound full rows under query_only", () => {
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
      expect(firstPage).toEqual({ tasks: [selected[2]!], hasMore: true });
      secondPage = task.getPage({ ...input, startingAfter: firstPage.tasks[0]!.id });
      expect(secondPage).toEqual({ tasks: [selected[1]!], hasMore: true });
      const thirdPage = task.getPage({ ...input, startingAfter: secondPage.tasks[0]!.id });
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
      startingAfter: selectedFirstPage.tasks[0]!.id,
    });
    const continuationIds = liveContinuation.tasks.map(({ id }) => id);
    expect(continuationIds).not.toContain(selected[2]!.id);
    expect(continuationIds).not.toContain(selected[1]!.id);
  });
});

test("activity cursors follow updated event times between page calls", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const earlier = task.create({ project_id: app.id, title: "Earlier" }, actor);
    const later = task.create({ project_id: app.id, title: "Later" }, actor);
    getDb()
      .query("UPDATE activity SET created_at = CASE entity_id WHEN ? THEN 100 WHEN ? THEN 200 END WHERE entity_type = 'task' AND entity_id IN (?, ?)")
      .run(earlier.id, later.id, earlier.id, later.id);

    const firstPage = task.getPage({ sort: "activity", limit: 1 });
    expect(firstPage).toEqual({ tasks: [later], hasMore: true });
    getDb()
      .query("UPDATE activity SET created_at = 300 WHERE entity_type = 'task' AND entity_id = ?")
      .run(earlier.id);
    expect(task.getPage({ sort: "activity", limit: 1, startingAfter: later.id })).toEqual({
      tasks: [],
      hasMore: false,
    });
  });
});
