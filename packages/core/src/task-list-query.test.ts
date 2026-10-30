import { expect, spyOn, test } from "bun:test";

import { column, label, project, task } from "../index.js";
import { getDb } from "./db.js";
import { Statement } from "./sqlite/database.js";
import { withTestStore } from "./testing.js";

const actor = { name: "Task list query", email: null, kind: "human" as const };
const LARGE_DESCRIPTION_LENGTH = 16_384;
const LARGE_DESCRIPTION = "x".repeat(LARGE_DESCRIPTION_LENGTH);

type StatementWithAll = { all(...params: Array<unknown>): Array<unknown> };

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
      expect(task.getAll({ sort: "activity", limit: 1 })).toHaveLength(1);
      expect(materializedTaskRows).toEqual([2, 1, 2, 7]);
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
