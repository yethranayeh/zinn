import { expect, test } from "bun:test";
import { activity, label, project, task, timestampSchema, activityTimestampSchema } from "../index";
import { getDb } from "./db";
import { taskCreateSchema, taskEditSchema, taskListSchema, taskSearchSchema } from "./schemas/task";
import { activityListSchema } from "./schemas/activity";
import { withTestStore } from "./testing";

const actor = { name: "Deadline test", email: null, kind: "human" as const };

test("deadlines create, change, clear and preserve no-op timestamps and activity", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const undated = task.create({ project_id: app.id, title: "Undated" }, actor);
    const dated = task.create({ project_id: app.id, title: "Dated", due_at: 0 }, actor);
    expect(undated.due_at).toBeNull();
    expect(task.activity(undated.key).find(event => event.action === "create")!.changes!.due_at).toBeNull();
    expect(task.activity(dated.key).find(event => event.action === "create")!.changes!.due_at).toBe(0);
    for (const [key, deadline] of [[undated.key, null], [dated.key, 0]] as const) {
      getDb().query("UPDATE task SET updated_at = 1 WHERE id = ?").run(task.getByKey(key).id);
      const before = task.getByKey(key);
      const history = task.activity(key);
      const writes = getDb().query<{ writes: number }>("SELECT total_changes() AS writes").get()!.writes;
      expect(task.edit({ taskKey: key, due_at: deadline }, actor)).toEqual({ task: before, changed: false });
      expect(task.activity(key)).toEqual(history);
      expect(getDb().query<{ writes: number }>("SELECT total_changes() AS writes").get()!.writes).toBe(writes);
    }
    const edited = task.edit({ taskKey: undated.key, due_at: -1 }, actor);
    expect(edited.changed).toBe(true);
    expect(edited.task.updated_at).toBeGreaterThan(1);
    expect(task.activity(undated.key).find(event => event.action === "edit")!.changes).toEqual({ due_at: [null, -1] });
    expect(task.edit({ taskKey: undated.key, title: "Renamed" }, actor).task.due_at).toBe(-1);
    task.archive(undated.key, actor);
    expect(task.edit({ taskKey: undated.key, due_at: null }, actor).task.due_at).toBeNull();
    const deadlineEvents = activity.getAll({ taskKey: undated.key, changed: [{ field: "due_at" }] }).events;
    expect(deadlineEvents).toHaveLength(3);
    expect(deadlineEvents.filter(event => event.action === "edit").map(event => event.changes!.due_at))
      .toEqual([[-1, null], [null, -1]]);
    const createEvent = task.activity(dated.key).find(event => event.action === "create")!;
    getDb().query("UPDATE activity SET changes = ? WHERE id = ?")
      .run(JSON.stringify({ title: "Historical snapshot" }), createEvent.id);
    expect(activity.getAll({ taskKey: dated.key, changed: [{ field: "due_at" }] }).events).toEqual([]);
  });
});

test("deadline filters intersect scope and labels before limits and keep stable board ties", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    label.create({ name: "selected" }, actor);
    const create = (due_at: number | null, selected = true, columnName = "Backlog") => task.create({
      project_id: app.id, title: "Deadline needle", due_at,
      columnName, labelNames: selected ? ["selected"] : [],
    }, actor);
    const undated = create(null);
    const later = create(20);
    const zero = create(0);
    const tie = create(0, true, "Done");
    const excluded = create(-2, false);
    const negative = create(-1);
    task.create({ project_id: other.id, title: "Deadline needle", due_at: 0 }, actor);
    const archived = create(0);
    task.archive(archived.key, actor);
    const board = task.getAll({ projectKey: app.key });
    const rowsBefore = getDb().query("SELECT * FROM task ORDER BY id").all();
    expect(task.getAll({ projectKey: app.key, sort: "due" }).map(row => row.key))
      .toEqual([excluded.key, negative.key, zero.key, tie.key, later.key, undated.key]);
    expect(task.getAll({ projectKey: app.key, dueSince: 0, dueUntil: 0, labelNames: ["SELECTED"], limit: 1 }).map(row => row.key)).toEqual([zero.key]);
    expect(task.getAll({ projectKey: app.key, dueSince: 0, dueUntil: 0, columnName: "done" }).map(row => row.key)).toEqual([tie.key]);
    expect(task.getAll({ projectKey: app.key, dueUntil: -1, labelNames: ["selected"] }).map(row => row.key)).toEqual([negative.key]);
    expect(task.getAll({ projectKey: app.key, dueSince: 20 }).map(row => row.key)).toEqual([later.key]);
    expect(task.getAll({ projectKey: app.key, archive: "archived", dueSince: 0, dueUntil: 0 }).map(row => row.key)).toEqual([archived.key]);
    expect(task.getAll({ projectKey: app.key })).toEqual(board);
    expect(getDb().query("SELECT * FROM task ORDER BY id").all()).toEqual(rowsBefore);
    const searchBefore = task.search({ query: "needle", projectKey: app.key });
    const filtered = task.search({ query: "needle", projectKey: app.key, dueSince: 0, dueUntil: 0, labelNames: ["selected"], limit: 1 });
    expect(filtered.tasks.map(row => row.key)).toEqual([zero.key]);
    expect(filtered.hiddenArchivedCount).toBe(1);
    expect(task.search({ query: "needle", projectKey: app.key, dueUntil: -1, labelNames: ["selected"] }).hiddenArchivedCount).toBe(0);
    for (const key of [undated.key, later.key]) {
      expect(task.search({ query: key, dueSince: 0, dueUntil: 0, limit: 1 }).tasks).toEqual([]);
    }
    expect(task.search({ query: zero.key, dueSince: 0, dueUntil: 0 }).tasks.map(row => row.key)).toEqual([zero.key]);
    expect(task.search({ query: "needle", projectKey: app.key })).toEqual(searchBefore);
  });
});

test("deadline schemas reuse the timestamp range and reject reversed bounds and valued activity filters", () => {
  for (const value of [-8_640_000_000_000_000, -1, 0, 8_640_000_000_000_000]) {
    expect(activityTimestampSchema.parse(value)).toBe(timestampSchema.parse(value));
  }
  for (const value of [NaN, Infinity, 0.1, 8_640_000_000_000_001]) {
    expect(activityTimestampSchema.safeParse(value).success).toBe(false);
  }
  for (const due_at of [null, -8_640_000_000_000_000, -1, 0, 8_640_000_000_000_000]) {
    expect(taskCreateSchema.parse({ project_id: "id", title: "Task", due_at }).due_at).toBe(due_at);
    expect(taskEditSchema.parse({ taskKey: "APP-1", due_at }).due_at).toBe(due_at);
  }
  for (const due_at of ["0", NaN, Infinity, 0.1, 8_640_000_000_000_001]) {
    expect(taskCreateSchema.safeParse({ project_id: "id", title: "Task", due_at }).success).toBe(false);
    expect(taskEditSchema.safeParse({ taskKey: "APP-1", due_at }).success).toBe(false);
  }
  expect(taskListSchema.safeParse({ dueSince: 1, dueUntil: 0 }).error?.issues[0]?.path).toEqual(["dueUntil"]);
  expect(taskSearchSchema.safeParse({ query: "needle", dueSince: 1, dueUntil: 0 }).error?.issues[0]?.path).toEqual(["dueUntil"]);
  expect(taskListSchema.parse({ dueSince: 0, dueUntil: 0 })).toMatchObject({ dueSince: 0, dueUntil: 0 });
  expect(taskSearchSchema.parse({ query: "needle", dueSince: 0, dueUntil: 0 })).toMatchObject({ dueSince: 0, dueUntil: 0 });
  for (const value of [0, null, "none"]) {
    expect(activityListSchema.safeParse({ changed: [{ field: "due_at", value }] }).success).toBe(false);
  }
});
