import { expect, spyOn, test } from "bun:test";

import { column, label, project, task } from "../index.js";
import type { TaskWithKey } from "../index.js";
import { getDb } from "./db.js";
import { Statement } from "./sqlite/database.js";
import { withTestStore } from "./testing.js";

const actor = { name: "Task list query", email: null, kind: "human" as const };
const LARGE_DESCRIPTION_LENGTH = 16_384;
const LARGE_DESCRIPTION = "x".repeat(LARGE_DESCRIPTION_LENGTH);
const ACTIVITY_TIMESTAMP = 100;

type StatementWithAll = { all(...params: Array<unknown>): Array<unknown> };
type StatementWithGet = { get(...params: Array<unknown>): unknown };

function isTaskRow(row: unknown): row is { project_id: string; task_order: string } {
  return row !== null && typeof row === "object" && "project_id" in row && "task_order" in row;
}

test("board and due limits materialize filtered task rows before returning", () => {
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
      hasLabel = false,
      description = "",
    ) => task.create({
      project_id: projectId,
      title,
      description,
      due_at: dueAt,
      columnName,
      labelNames: hasLabel ? ["selected"] : [],
    }, actor);

    const appBacklog = create(app.id, "Selected backlog", 0, undefined, true, LARGE_DESCRIPTION);
    const appKelvin = create(app.id, "Selected Kelvin", 0, "Kelvin", true);
    create(app.id, "Unselected Kelvin", 0, "Kelvin", false, LARGE_DESCRIPTION);
    create(app.id, "Selected without Kelvin", 0, undefined, true, LARGE_DESCRIPTION);
    create(app.id, "Selected later Kelvin", 1, "Kelvin", true, LARGE_DESCRIPTION);
    const appEarlier = create(app.id, "Selected earlier Kelvin", -1, "Kelvin", true, LARGE_DESCRIPTION);
    const otherKelvin = create(other.id, "Selected other Kelvin", 0, "Kelvin", true);
    getDb().query("UPDATE activity SET created_at = ?").run(ACTIVITY_TIMESTAMP);
    const beforeTasks = getDb().query("SELECT * FROM task ORDER BY id").all();
    const beforeActivity = getDb().query("SELECT * FROM activity ORDER BY id").all();

    const materializedTaskRows: Array<number> = [];
    const statementPrototype = Statement.prototype as unknown as StatementWithAll;
    const originalAll = statementPrototype.all;
    const reader = spyOn(statementPrototype, "all").mockImplementation(function (
      this: StatementWithAll,
      ...params: Array<unknown>
    ) {
      const rows = originalAll.apply(this, params);
      if (rows.length > 0 && isTaskRow(rows[0])) {
        materializedTaskRows.push(rows.length);
      }
      return rows;
    });

    try {
      getDb().exec("PRAGMA query_only = ON");

      expect(task.getAll({
        labelNames: ["selected"],
        columnName: "kelvin",
        dueSince: 0,
        dueUntil: 0,
      }).map(({ key }) => key)).toEqual([appKelvin.key, otherKelvin.key]);
      expect(task.getAll({
        labelNames: ["selected", "SELECTED"],
        columnName: "kelvin",
        dueSince: 0,
        dueUntil: 0,
        limit: 1,
      }).map(({ key }) => key)).toEqual([appKelvin.key]);
      expect(task.getAll({ sort: "due", labelNames: ["selected"], limit: 2 }).map(({ key }) => key))
        .toEqual([appEarlier.key, appBacklog.key]);
      expect(task.getAll({ sort: "activity", limit: 1 }).map(({ key }) => key)).toEqual([appBacklog.key]);
      expect(task.getAll({
        sort: "activity",
        labelNames: ["selected"],
        columnName: "kelvin",
        dueSince: 0,
        dueUntil: 0,
        limit: 1,
      }).map(({ key }) => key)).toEqual([appKelvin.key]);
      expect(task.getAll({ sort: "activity" })).toHaveLength(7);
      expect(materializedTaskRows).toEqual([2, 1, 2, 1, 1, 7]);
      expect(getDb().query<{ query_only: number }>("PRAGMA query_only").get()?.query_only).toBe(1);
      expect(getDb().query("SELECT * FROM task ORDER BY id").all()).toEqual(beforeTasks);
      expect(getDb().query("SELECT * FROM activity ORDER BY id").all()).toEqual(beforeActivity);
    } finally {
      reader.mockRestore();
    }
  });
});

test("unknown columns select nothing while label and project errors keep their precedence", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);

    expect(task.getAll({ projectKey: "APP", columnName: "missing" })).toEqual([]);
    expect(() => task.getAll({ projectKey: "APP", columnName: "missing", labelNames: ["missing"] }))
      .toThrow(expect.objectContaining({
        kind: "missing",
        facts: expect.objectContaining({ entity: "label" }),
      }));
    expect(() => task.getAll({ projectKey: "MISSING", labelNames: ["missing"] }))
      .toThrow(expect.objectContaining({
        kind: "missing",
        facts: expect.objectContaining({ entity: "project" }),
      }));
  });
});

test("task lists and pages reuse selected project keys without per-task project reads", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    const create = (projectId: string, title: string, dueAt: number | null) =>
      task.create({ project_id: projectId, title, due_at: dueAt }, actor);
    const appFirst = create(app.id, "App first", null);
    const appEarlier = create(app.id, "App earlier", -1);
    const appArchived = create(app.id, "App archived", 2);
    const otherFirst = create(other.id, "Other first", 0);
    const otherEarlier = create(other.id, "Other earlier", -1);
    const otherArchived = create(other.id, "Other archived", null);
    task.archive(appArchived.key, actor);
    task.archive(otherArchived.key, actor);
    getDb().query(`UPDATE activity SET created_at = CASE entity_id
      WHEN $appEarlier THEN 300 WHEN $appArchived THEN 400
      WHEN $otherEarlier THEN 500 WHEN $otherArchived THEN 300 ELSE 100 END
      WHERE entity_type = 'task'`).run({
      $appEarlier: appEarlier.id,
      $appArchived: appArchived.id,
      $otherEarlier: otherEarlier.id,
      $otherArchived: otherArchived.id,
    });

    const orders = {
      board: [appFirst, appEarlier, appArchived, otherFirst, otherEarlier, otherArchived],
      due: [appEarlier, otherEarlier, otherFirst, appArchived, appFirst, otherArchived],
      activity: [otherEarlier, appArchived, appEarlier, otherArchived, appFirst, otherFirst],
    };
    const snapshots = new Map(
      orders.board.map(({ key }) => [key, task.getByKey(key)]),
    );
    const projectReads: Array<string> = [];
    const statementPrototype = Statement.prototype as unknown as StatementWithGet;
    const originalGet = statementPrototype.get;
    const reader = spyOn(statementPrototype, "get").mockImplementation(function (
      this: StatementWithGet,
      ...params: Array<unknown>
    ) {
      const row = originalGet.apply(this, params);
      if (row !== null && typeof row === "object" && "task_count" in row && "key" in row) {
        projectReads.push(row.key as string);
      }
      return row;
    });

    try {
      getDb().exec("PRAGMA query_only = ON");
      for (const projectKey of [undefined, app.key]) {
        const expectedProjectReads = projectKey === undefined ? [] : [projectKey];
        const check = <T>(read: () => T, expected: T) => {
          projectReads.length = 0;
          expect(read()).toEqual(expected);
          expect(projectReads).toEqual(expectedProjectReads);
        };
        for (const sort of [undefined, "due", "activity"] as const) {
          for (const archive of ["active", "archived", "all"] as const) {
            const selection = { projectKey, sort, archive };
            const expected = orders[sort ?? "board"]
              .map(({ key }) => snapshots.get(key)!)
              .filter((row) => projectKey === undefined || row.project_id === app.id)
              .filter((row) => archive === "all" || (row.archived_at !== null) === (archive === "archived"));
            check(() => task.getAll(selection), expected);
            check(() => task.getAll({ ...selection, limit: 1 }), expected.slice(0, 1));
            check(() => task.getPage(selection), { tasks: expected, hasMore: false });

            let startingAfter: string | undefined;
            for (let index = 0; index < Math.max(expected.length, 1); index++) {
              const tasks: Array<TaskWithKey> = expected.slice(index, index + 1);
              let nextCursor: string | undefined;
              check(() => {
                const { nextCursor: cursor, ...page } = task.getPage({ ...selection, limit: 1, startingAfter });
                nextCursor = cursor;
                return page;
              }, {
                tasks,
                hasMore: index + 1 < expected.length,
              });
              startingAfter = nextCursor;
            }
          }
        }
      }
      projectReads.length = 0;
      expect(task.getAll({ columnName: "missing" })).toEqual([]);
      expect(task.getPage({ columnName: "missing", limit: 1 })).toEqual({ tasks: [], hasMore: false });
      expect(projectReads).toEqual([]);
    } finally {
      reader.mockRestore();
    }
  });
});
