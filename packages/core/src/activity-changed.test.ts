import { expect, test } from "bun:test";
import { activity, activityActionSchema, activityChangedFieldSchema, column, comment, label, project, task } from "../index";
import type { ActivityListInput } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { withTestStore } from "./testing";

const actor = { name: "Activity test", email: null, kind: "human" as const };

test("action filters select every recorded action and combine before the limit", () => {
  withTestStore(() => {
    getDb({ createsDatabase: true });
    const events = activityActionSchema.options.map((action, index) => dbActivity.create({
      created_at: index, actor_name: actor.name, actor_email: null, actor_kind: actor.kind,
      actor_source: null, actor_session_id: "Session", actor_thread_id: "Thread",
      actor_agent: null, actor_model: null, actor_effort: null, actor_client: null,
      entity_type: "task", entity_id: "historical", action,
      changes: action === "edit" ? { priority: [null, "high"] } : null,
    }));
    const before = activity.getAll().events;
    for (const event of events) {
      expect(activity.getAll({ actions: [event.action] }).events).toEqual([event]);
    }
    const selected = before.filter(event => event.action === "edit" || event.action === "comment_create");
    expect(activity.getAll({ actions: ["edit", "comment_create"] }).events).toEqual(selected);
    expect(activity.getAll({ actions: ["edit", "comment_create"], limit: 1 }).events).toEqual(selected.slice(0, 1));
    expect(activity.getAll({ actions: ["edit"], changed: [{ field: "priority", value: "HIGH" }], sessionId: "Session", threadId: "Thread" }).events)
      .toEqual(events.filter(event => event.action === "edit"));
    expect(activity.getAll({ actions: ["comment_create"], changed: [{ field: "priority", value: "high" }] }).events).toEqual([]);
    expect(activity.getAll({ actions: ["edit"], threadId: "thread" }).events).toEqual([]);
    expect(activity.getAll().events).toEqual(before);
  });
});

test("changed filters match initial values, new priorities, moves and added labels", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    label.create({ name: "bug" }, actor);
    label.create({ name: "triage" }, actor);
    const item = task.create({ project_id: app.id, title: "Item", priority: "medium", labelNames: ["bug"] }, actor);
    const created = activity.getAll({ taskKey: item.key }).events[0]!;
    const query = (changed: ActivityListInput["changed"]) => activity.getAll({ taskKey: item.key, changed }).events;

    expect(query([{ field: "column", value: "backlog" }, { field: "priority", value: "MEDIUM" }, { field: "labels", value: "BUG" }])).toEqual([created]);
    task.edit({ taskKey: item.key, title: "Edited while labeled", addLabelNames: ["bug"] }, actor);
    task.edit({ taskKey: item.key, priority: "high", addLabelNames: ["bug"] }, actor);
    const prioritized = activity.getAll({ taskKey: item.key }).events[0]!;
    task.move({ taskKey: item.key, targetColumn: "Review" }, actor);
    const moved = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, priority: "urgent", addLabelNames: ["triage"] }, actor);
    const combined = activity.getAll({ taskKey: item.key }).events[0]!;
    task.label.remove({ taskKey: item.key, labelNames: ["bug"] }, actor);
    task.label.add({ taskKey: item.key, labelNames: ["bug"] }, actor);
    const added = activity.getAll({ taskKey: item.key }).events[0]!;
    label.delete({ name: "bug" }, actor);
    comment.create({ taskKey: item.key, text: "column=Review priority=high labels=bug" }, actor);

    expect(query([{ field: "priority", value: "HIGH" }])).toEqual([prioritized]);
    expect(query([{ field: "column", value: "review" }])).toEqual([moved]);
    expect(query([{ field: "labels", value: "bug" }])).toEqual([added, created]);
    expect(query([{ field: "labels", value: "triage" }, { field: "priority", value: "urgent" }])).toEqual([combined]);
    expect(query([{ field: "labels", value: "bug" }, { field: "priority", value: "high" }])).toEqual([]);
    expect(query([{ field: "column", value: "Review" }, { field: "labels", value: "triage" }])).toEqual([]);
    expect(query([{ field: "priority", value: "high" }, { field: "priority", value: "URGENT" }])).toEqual([combined, prioritized]);
    expect(query([{ field: "labels", value: "triage" }, { field: "labels", value: "bug" }])).toEqual([added, combined, created]);
    expect(query([{ field: "labels", value: "missing" }])).toEqual([]);
    expect(query([])).toEqual(activity.getAll({ taskKey: item.key }).events);
  });
});

test("value-free filters match task creation, clearing and label removals in the same event", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP", description: "Project description" }, actor);
    label.create({ name: "bug", description: "Label description" }, actor);
    const item = task.create({ project_id: app.id, title: "Initial" }, actor);
    const created = activity.getAll({ taskKey: item.key }).events[0]!;
    const query = (changed: ActivityListInput["changed"], actions?: ActivityListInput["actions"]) =>
      activity.getAll({ taskKey: item.key, changed, actions }).events;
    for (const field of activityChangedFieldSchema.options.filter(field => field !== "labels")) {
      expect(query([{ field }])).toEqual([created]);
    }
    expect(query([{ field: "labels" }])).toEqual([]);

    task.edit({ taskKey: item.key, title: "Renamed" }, actor);
    const renamed = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, description: "Description", priority: "high", addLabelNames: ["bug"] }, actor);
    const combined = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, description: null, priority: null, removeLabelNames: ["bug"] }, actor);
    const cleared = activity.getAll({ taskKey: item.key }).events[0]!;
    const beforeNoOps = activity.getAll().events;
    task.edit({ taskKey: item.key, description: null, priority: null, removeLabelNames: ["bug"] }, actor);
    expect(activity.getAll().events).toEqual(beforeNoOps);
    task.move({ taskKey: item.key, targetColumn: "Review" }, actor);
    const moved = activity.getAll({ taskKey: item.key }).events[0]!;
    comment.create({ taskKey: item.key, text: "A description comment" }, actor);
    project.edit({ projectKey: app.key, description: "Updated project" }, actor);
    label.edit({ labelName: "bug", description: "Updated label" }, actor);

    expect(query([{ field: "title" }])).toEqual([renamed, created]);
    expect(query([{ field: "description" }])).toEqual([cleared, combined, created]);
    expect(query([{ field: "priority" }])).toEqual([cleared, combined, created]);
    expect(query([{ field: "column" }])).toEqual([moved, created]);
    expect(query([{ field: "labels" }])).toEqual([cleared, combined]);
    expect(query([{ field: "labels", value: "bug" }])).toEqual([combined]);
    expect(query([{ field: "labels" }, { field: "labels", value: "missing" }])).toEqual([cleared, combined]);
    expect(query([{ field: "labels" }, { field: "priority", value: "high" }])).toEqual([combined]);
    expect(query([{ field: "description" }], ["edit"])).toEqual([cleared, combined]);
    expect(query([{ field: "title" }, { field: "description" }], ["edit"])).toEqual([]);
    expect(activity.getAll({ changed: [{ field: "description" }] }).events).toEqual([cleared, combined, created]);

    task.label.add({ taskKey: item.key, labelNames: ["bug"] }, actor);
    const added = activity.getAll({ taskKey: item.key }).events[0]!;
    label.delete({ name: "bug" }, actor);
    const removed = activity.getAll({ taskKey: item.key }).events[0]!;
    expect(query([{ field: "labels" }])).toEqual([removed, added, cleared, combined]);
    expect(query([{ field: "labels", value: "bug" }])).toEqual([added, combined]);
  });
});

test("null priority filters match creation and clearing without treating names as sentinels", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    column.create({ projectKey: app.key, name: "none" }, actor);
    label.create({ name: "none" }, actor);
    const item = task.create({ project_id: app.id, title: "Unassigned", columnName: "none", labelNames: ["none"] }, actor);
    const created = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, priority: "high" }, actor);
    const prioritized = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, priority: null }, actor);
    const cleared = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, title: "Still unassigned" }, actor);
    const query = (changed: ActivityListInput["changed"]) => activity.getAll({ taskKey: item.key, changed }).events;

    expect(query([{ field: "priority", value: null }])).toEqual([cleared, created]);
    expect(query([{ field: "priority", value: null }, { field: "priority", value: "HIGH" }])).toEqual([cleared, prioritized, created]);
    expect(query([{ field: "column", value: "NONE" }, { field: "labels", value: "none" }, { field: "priority", value: null }])).toEqual([created]);
    expect(query([{ field: "priority", value: "none" }])).toEqual([]);
  });
});

test("changed filters use recorded names after renaming and deletion", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    label.create({ name: "needs=review" }, actor);
    const item = task.create({ project_id: app.id, title: "Historical", columnName: "Review", labelNames: ["needs=review"] }, actor);
    const created = activity.getAll({ taskKey: item.key }).events[0]!;
    column.edit({ projectKey: app.key, columnName: "Review", name: "Accepted" }, actor);
    label.edit({ labelName: "needs=review", name: "checked" }, actor);
    task.move({ taskKey: item.key, targetColumn: "TODO" }, actor);
    task.move({ taskKey: item.key, targetColumn: "Accepted" }, actor);
    const moved = activity.getAll({ taskKey: item.key }).events[0]!;
    project.delete(app.key, actor);
    label.delete({ name: "checked" }, actor);
    const query = (changed: ActivityListInput["changed"]) => activity.getAll({ taskId: item.id, changed }).events;

    expect(query([{ field: "column", value: "review" }, { field: "labels", value: "NEEDS=REVIEW" }])).toEqual([created]);
    expect(query([{ field: "column", value: "Accepted" }])).toEqual([moved]);
    expect(query([{ field: "labels", value: "checked" }])).toEqual([]);
    expect(activity.getAll({ projectId: app.id, changed: [{ field: "column", value: "review" }] }).events).toEqual([created]);
  });
});

test("changed filters combine with every identity selector, session and thread before limiting", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTHER" }, actor);
    const attributed = { ...actor, sessionId: "Session", threadId: "Thread" };
    const item = task.create({ project_id: app.id, title: "Match", priority: "high" }, attributed);
    const created = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, priority: "low" }, attributed);
    task.edit({ taskKey: item.key, priority: "high" }, attributed);
    const edited = activity.getAll({ taskKey: item.key }).events[0]!;
    task.edit({ taskKey: item.key, priority: "medium" }, attributed);
    task.edit({ taskKey: item.key, priority: "high" }, { ...attributed, threadId: "Different" });
    task.create({ project_id: app.id, title: "Other session", priority: "high" }, { ...attributed, sessionId: "Other" });
    task.create({ project_id: other.id, title: "Other project", priority: "high" }, attributed);
    const before = activity.getAll().events;
    const changesBefore = getDb().query<{ count: number }>("SELECT total_changes() AS count").get()!.count;

    for (const selector of [{ taskKey: item.key }, { taskId: item.id }, { projectKey: app.key }, { projectId: app.id }]) {
      const query = { ...selector, sessionId: "Session", threadId: "Thread", changed: [{ field: "priority", value: "HIGH" }] } satisfies ActivityListInput;
      expect(activity.getAll(query).events).toEqual([edited, created]);
      expect(activity.getAll({ ...query, limit: 1 }).events).toEqual([edited]);
      expect(activity.getAll({ ...query, threadId: "thread" }).events).toEqual([]);
    }
    expect(activity.getAll().events).toEqual(before);
    expect(getDb().query<{ count: number }>("SELECT total_changes() AS count").get()!.count).toBe(changesBefore);
  });
});

test("changed filters ignore absent or unrelated payloads and preserve matching records in full", () => {
  withTestStore(() => {
    getDb({ createsDatabase: true });
    const base = {
      created_at: 1, actor_name: null, actor_email: null, actor_kind: "agent" as const,
      actor_source: null, actor_session_id: null, actor_thread_id: null, actor_agent: null,
      actor_model: null, actor_effort: null, actor_client: null, entity_type: "task" as const, entity_id: "historical",
    };
    const malformed = [null, {}, { priority: 1 }, { priority: [] }, { priority: ["high"] }, { column: null }, { labels: { added: null } }, { labels: { removed: ["bug"] } }];
    for (const changes of malformed) {
      dbActivity.create({ ...base, action: "edit", changes });
    }
    dbActivity.create({ ...base, action: "move", changes: { column: [{ name: "Review" }] } });
    for (const action of ["delete", "order", "archive", "comment_edit"] as const) {
      dbActivity.create({ ...base, action, changes: { priority: ["low", "high"], column: { name: "Review" }, labels: ["bug"] } });
    }
    dbActivity.create({ ...base, entity_type: "project", action: "create", changes: { column: { name: "Review" }, priority: "high", labels: ["bug"] } });
    const matching = dbActivity.create({ ...base, action: "edit", changes: { priority: ["low", "HIGH"], future: { full: "Long\nrecorded text", values: [null, 1] } } });

    expect(activity.getAll({ changed: [{ field: "priority", value: "high" }] }).events).toEqual([matching]);
    expect(activity.getAll({ changed: [{ field: "column", value: "Review" }] }).events).toEqual([]);
    expect(activity.getAll({ changed: [{ field: "labels", value: "bug" }] }).events).toEqual([]);
  });
});
