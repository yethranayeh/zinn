import { expect, test } from "bun:test";
import { MAX_LIST_LIMIT, activity, project, label, task, comment, taskListSchema, taskSearchSchema, activityListSchema, parseTaskKey } from "../index";
import { withTestStore } from "./testing";

test("list schemas share limits from 1 through 11871 without widening readable keys", () => {
  const inputs = [
    { schema: taskListSchema, input: {} },
    { schema: taskSearchSchema, input: { query: "needle" } },
    { schema: activityListSchema, input: {} },
  ];
  for (const { schema, input } of inputs) {
    for (const limit of [1, 10, 11_870, 11_871]) {
      expect(schema.safeParse({ ...input, limit }).success).toBe(true);
    }
    for (const limit of [0, -1, 1.5, 11_872, Infinity, NaN, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      expect(schema.safeParse({ ...input, limit }).error?.issues[0]?.path).toEqual(["limit"]);
    }
  }
  expect(parseTaskKey("APP-999999999999999")).not.toBeNull();
  expect(parseTaskKey("APP-1000000000000000")).toBeNull();
  expect(() => comment.getByKey("APP-1#1000000000000000")).toThrow(expect.objectContaining({ kind: "input" }));
});

test("task limits follow all filters and preserve global and project order", () => {
  withTestStore(() => {
    const actor = { name: "Test", email: null, kind: "human" as const };
    label.create({ name: "bug" }, actor);
    label.create({ name: "cli" }, actor);
    label.create({ name: "absent" }, actor);
    for (const key of ["APP", "OTHER"]) {
      const app = project.create({ key }, actor);
      for (let index = 0; index < 6; index++) {
        const created = task.create({
          project_id: app.id, title: "needle", labelNames: index === 0 ? [] : ["bug", "cli"],
        }, actor);
        if (index > 0) {
          task.move({ taskKey: created.key, targetColumn: "Done" }, actor);
        }
        if (index >= 4) {
          task.archive(created.key, actor);
        }
      }
      task.order({ taskKey: `${key}-4`, direction: "top" }, actor);
    }
    for (const projectKey of [undefined, "app"]) {
      for (const archive of [undefined, "active", "archived", "all"] as const) {
        for (const columnName of [undefined, "done"]) {
          for (const labelNames of [undefined, ["BUG", "CLI"], ["absent"]]) {
            const input = { projectKey, archive, columnName, labelNames };
            const all = task.getAll(input);
            expect(task.getAll({ ...input, limit: 2 })).toEqual(all.slice(0, 2));
            expect(task.getAll({ ...input, limit: MAX_LIST_LIMIT })).toEqual(all);
          }
        }
      }
    }
    const selected = task.getAll({ projectKey: "APP", columnName: "Done", labelNames: ["bug", "cli"], limit: 2 });
    expect(selected.map(value => value.key)).toEqual(["APP-4", "APP-2"]);
    const search = task.search({ query: "needle" });
    expect(search.tasks).toHaveLength(8);
    expect(search.hiddenArchivedCount).toBe(4);
    expect(task.search({ query: "needle", limit: 1 })).toEqual({ tasks: search.tasks.slice(0, 1), hiddenArchivedCount: 4 });
    const events = activity.getAll();
    expect(activity.getAll({ limit: MAX_LIST_LIMIT })).toEqual(events);
  });
});
