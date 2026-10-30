import { expect, spyOn, test } from "bun:test";
import { comment, label, project, relation, task, taskListSchema } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { withTestStore } from "./testing";

const actor = { name: "Test", email: null, kind: "human" as const };

test("activity sorting follows task changes, comments and both relation endpoints", () => {
  withTestStore(() => {
    let now = Date.UTC(2026, 0, 1);
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const app = project.create({ key: "APP" }, actor);
      label.create({ name: "bug" }, actor);
      const first = task.create({ project_id: app.id, title: "First" }, actor);
      const second = task.create({ project_id: app.id, title: "Second" }, actor);
      const third = task.create({ project_id: app.id, title: "Third" }, actor);
      const keys = () => task.getAll({ sort: "activity" }).map(({ key }) => key);
      expect(keys()).toEqual([first.key, second.key, third.key]);

      now++;
      task.edit({ taskKey: second.key, title: "Edited" }, actor);
      expect(keys()).toEqual([second.key, first.key, third.key]);
      now++;
      task.move({ taskKey: first.key, targetColumn: "Done" }, actor);
      const firstUpdatedAt = task.getByKey(first.key).updated_at;
      expect(keys()).toEqual([first.key, second.key, third.key]);
      now++;
      task.label.add({ taskKey: third.key, labelNames: ["bug"] }, actor);
      expect(keys()).toEqual([third.key, first.key, second.key]);
      now++;
      const note = comment.create({ taskKey: first.key, text: "Context" }, actor);
      expect(keys()).toEqual([first.key, third.key, second.key]);
      expect(task.getByKey(first.key).updated_at).toBe(firstUpdatedAt);

      const link = { sourceTaskKey: first.key, targetTaskKey: second.key, relation_type: "related" as const };
      now++;
      relation.create(link, actor);
      expect(keys()).toEqual([second.key, first.key, third.key]);
      now++;
      task.edit({ taskKey: third.key, title: "Third edited" }, actor);
      expect(keys()).toEqual([third.key, second.key, first.key]);
      now++;
      relation.delete(link, actor);
      expect(keys()).toEqual([second.key, first.key, third.key]);
      expect(task.getByKey(first.key).updated_at).toBe(firstUpdatedAt);
      now++;
      comment.edit({ commentKey: note.key, text: "More context" }, actor);
      expect(keys()).toEqual([first.key, second.key, third.key]);
      now++;
      task.edit({ taskKey: second.key, title: "Edited again" }, actor);
      expect(keys()).toEqual([second.key, first.key, third.key]);
      now++;
      comment.delete({ commentKey: note.key }, actor);
      expect(keys()).toEqual([first.key, second.key, third.key]);
      now++;
      task.edit({ taskKey: third.key, title: "Third edited" }, actor);
      expect(keys()).toEqual([first.key, second.key, third.key]);
      expect(task.getAll().map(({ key }) => key)).toEqual([second.key, third.key, first.key]);
    } finally {
      clock.mockRestore();
    }
  });
});

test("activity sorting uses event timestamps and falls back only when task history is absent", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const first = task.create({ project_id: app.id, title: "First" }, actor);
    const second = task.create({ project_id: app.id, title: "Second" }, actor);
    const third = task.create({ project_id: app.id, title: "Third" }, actor);
    comment.create({ taskKey: first.key, text: "Newer ID, older time" }, actor);
    const db = getDb();
    db.query("UPDATE activity SET created_at = 50 WHERE entity_id = ? AND action = 'create'").run(first.id);
    db.query("UPDATE activity SET created_at = 20 WHERE entity_id = ? AND action = 'comment_create'").run(first.id);
    db.query("DELETE FROM activity WHERE entity_type = 'task' AND entity_id = ?").run(second.id);
    db.query("UPDATE task SET updated_at = 40 WHERE id = ?").run(second.id);
    db.query("UPDATE activity SET created_at = 0 WHERE entity_id = ?").run(third.id);
    const { id: eventId, ...event } = task.activity(first.key)[0]!;
    dbActivity.create({ ...event, entity_type: "project", entity_id: third.id, created_at: 100 });
    dbActivity.create({ ...event, entity_id: "deleted-task", created_at: 200 });

    expect(task.getAll({ sort: "activity" }).map(({ key }) => key)).toEqual([first.key, second.key, third.key]);
    expect(task.getAll({ sort: "activity", limit: 2 }).map(({ key }) => key)).toEqual([first.key, second.key]);
  });
});

test("activity sorting composes with every task filter and keeps board order on ties", () => {
  withTestStore(() => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    try {
      label.create({ name: "bug" }, actor);
      label.create({ name: "cli" }, actor);
      label.create({ name: "absent" }, actor);
      for (const key of ["OTHER", "APP"]) {
        const app = project.create({ key }, actor);
        for (let index = 0; index < 4; index++) {
          const created = task.create({ project_id: app.id, title: "Task", labelNames: index === 0 ? [] : ["bug", "cli"] }, actor);
          if (index > 0) {
            task.move({ taskKey: created.key, targetColumn: "Done" }, actor);
          }
          if (index === 3) {
            task.archive(created.key, actor);
          }
        }
        task.order({ taskKey: `${key}-3`, direction: "top" }, actor);
      }
      expect(task.getAll({ archive: "all" }).map(({ key }) => key)).toEqual([
        "APP-1", "APP-3", "APP-2", "APP-4", "OTHER-1", "OTHER-3", "OTHER-2", "OTHER-4",
      ]);
      expect(task.getAll({ archive: "all", sort: "activity" }).map(({ key }) => key)).toEqual([
        "APP-1", "APP-3", "APP-2", "APP-4", "OTHER-1", "OTHER-3", "OTHER-2", "OTHER-4",
      ]);
      for (const projectKey of [undefined, "app"]) {
        for (const archive of [undefined, "active", "archived", "all"] as const) {
          for (const columnName of [undefined, "done", "missing"]) {
            for (const labelNames of [undefined, ["BUG", "CLI"], ["absent"]]) {
              const input = { projectKey, archive, columnName, labelNames };
              const boardOrder = task.getAll(input);
              expect(task.getAll({ ...input, sort: "activity" })).toEqual(boardOrder);
              expect(task.getAll({ ...input, sort: "activity", limit: 2 })).toEqual(boardOrder.slice(0, 2));
            }
          }
        }
      }
    } finally {
      clock.mockRestore();
    }
  });
});

test("task sort rejects unsupported core values without widening other task inputs", () => {
  expect(taskListSchema.parse({ sort: "activity" }).sort).toBe("activity");
  expect(taskListSchema.parse({}).sort).toBeUndefined();
  for (const sort of ["", "updated", "Activity", "-activity", null, ["activity"], 1]) {
    expect(taskListSchema.safeParse({ sort }).error?.issues[0]?.path).toEqual(["sort"]);
  }
});
