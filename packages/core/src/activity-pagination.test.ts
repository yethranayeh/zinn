import { expect, spyOn, test } from "bun:test";
import { activity, comment, project, task } from "../index";
import type { Activity, ActivityListInput } from "../index";
import * as dbActivity from "./db/activity";
import { getDb } from "./db";
import { withTestStore } from "./testing";

const actor = { name: "Pagination", email: null, kind: "human" as const, sessionId: "Session", threadId: "Thread" };

function walk(input: ActivityListInput, expected: Array<Activity>, limit = 2) {
  const collected: Array<Activity> = [];
  let startingAfter: string | undefined;
  do {
    const page = activity.getAll({ ...input, limit, startingAfter });
    expect(page.events).toEqual(expected.slice(collected.length, collected.length + limit));
    collected.push(...page.events);
    expect(page.hasMore).toBe(collected.length < expected.length);
    if (!page.hasMore) {
      break;
    }
    startingAfter = page.events.at(-1)!.id;
  } while (collected.length <= expected.length);
  expect(collected).toEqual(expected);
  if (collected.length > 0) {
    expect(activity.getAll({ ...input, startingAfter: collected.at(-1)!.id, limit }))
      .toEqual({ events: [], hasMore: false });
  }
}

test("activity pages traverse timestamp ties, short and exact final pages without shifting under newer writes", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const item = task.create({ project_id: app.id, title: "Initial" }, actor);
    const { id: _id, ...template } = activity.getAll({ taskKey: item.key }).events[0]!;
    const events = Array.from({ length: 9 }, (_, index) => dbActivity.create({
      ...template,
      created_at: Math.floor(index / 3),
      changes: { title: ["before", `after ${index}`], extra: [null, { untouched: true }] },
    })).toReversed();
    const input = { until: 2 };
    for (const limit of [1, 2, 3, 20]) {
      walk(input, events, limit);
    }
    const first = activity.getAll({ ...input, limit: 2 });
    task.edit({ taskKey: item.key, title: "Newer" }, actor);
    expect(activity.getAll({ startingAfter: first.events[1]!.id }).events).toEqual(events.slice(2));
    expect(activity.getAll({ startingAfter: first.events[1]!.id }).hasMore).toBe(false);
    const changes = getDb().query("SELECT total_changes() AS changes").get();
    getDb().exec("PRAGMA query_only = ON");
    walk(input, events);
    expect(getDb().query("SELECT total_changes() AS changes").get()).toEqual(changes);
  });
});

test("pagination preserves every identity selector and evidence outside event filters", () => {
  withTestStore(() => {
    const first = project.create({ key: "APP" }, actor);
    const deleted = task.create({ project_id: first.id, title: "Deleted early" }, actor);
    task.edit({ taskKey: deleted.key, priority: "high" }, actor);
    comment.create({ taskKey: deleted.key, text: "Comment" }, actor);
    task.delete(deleted.key, actor);
    const cascaded = task.create({ project_id: first.id, title: "Cascaded" }, actor);
    project.delete(first.key, actor);
    const second = project.create({ key: "APP" }, actor);
    const current = task.create({ project_id: second.id, title: "Current" }, actor);
    task.edit({ taskKey: current.key, priority: "high" }, actor);
    task.archive(current.key, actor);

    const selectors: Array<ActivityListInput> = [
      {}, { projectKey: "APP" }, { projectKey: "APP", showDeleted: true },
      { projectId: first.id }, { projectId: second.id },
      { taskKey: current.key }, { taskKey: current.key, showDeleted: true },
      { taskId: deleted.id }, { taskId: cascaded.id }, { taskId: current.id },
    ];
    for (const selector of selectors) {
      for (const filters of [
        {}, { actions: ["edit", "comment_create"] as const },
        { since: 0, until: Date.now(), sessionId: actor.sessionId, threadId: actor.threadId,
          changed: [{ field: "priority" as const, value: "HIGH" }] },
      ]) {
        const input: ActivityListInput = { ...selector, ...filters, actions: filters.actions?.slice() };
        walk(input, activity.getAll(input).events, 1);
      }
    }
    const deletion = activity.getAll({ taskId: cascaded.id, actions: ["delete"] }).events;
    expect(deletion).toHaveLength(1);
    expect(deletion[0]!.entity_id).toBe(first.id);
    expect(deletion[0]!.changes?.tasks).toBeArray();
    const otherCursor = activity.getAll({ projectId: second.id }).events[0]!;
    expect(activity.getAll({ taskId: deleted.id, startingAfter: otherCursor.id }).events)
      .toEqual(activity.getAll({ taskId: deleted.id }).events);
  });
});

test("sparse changed matches fill pages and determine hasMore through bounded SQL batches", () => {
  withTestStore(() => {
    const base = project.create({ key: "APP" }, actor);
    const item = task.create({ project_id: base.id, title: "Initial" }, actor);
    const { id: _id, ...template } = activity.getAll({ taskKey: item.key }).events[0]!;
    const events = Array.from({ length: 40 }, (_, index) => dbActivity.create({
      ...template, created_at: index, action: "edit",
      changes: { priority: [null, index % 7 === 0 ? "high" : "low"], title: ["old", "new"] },
    })).toReversed();
    const input: ActivityListInput = { since: 0, until: 39, sessionId: "Session", threadId: "Thread",
      actions: ["edit"], changed: [{ field: "priority", value: "high" }, { field: "title" }] };
    const expected = events.filter((event) => (event.created_at % 7) === 0);
    const original = dbActivity.getAll;
    const reads: Array<{ limit: number | undefined; rows: number }> = [];
    const reader = spyOn(dbActivity, "getAll").mockImplementation((query = {}) => {
      const result = original(query);
      reads.push({ limit: query.limit, rows: result.length });
      return result;
    });
    try {
      walk(input, expected);
      expect(reads.length).toBeGreaterThan(3);
      expect(reads.every(({ limit, rows }) => limit === 3 && rows <= 3)).toBe(true);
      expect(activity.getAll({ ...input, threadId: "thread", limit: 2 })).toEqual({ events: [], hasMore: false });
    } finally {
      reader.mockRestore();
    }
  });
});

test("continuation uses global activity lookup spellings and errors independently of filters", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    task.create({ project_id: app.id, title: "First" }, actor);
    task.create({ project_id: app.id, title: "Second" }, actor);
    const events = activity.getAll().events;
    const cursor = events[1]!;
    for (const id of [cursor.id, cursor.id.toUpperCase(), cursor.id.replaceAll("-", ""), cursor.id.slice(0, -1)]) {
      expect(activity.getAll({ startingAfter: id }).events).toEqual(events.slice(2));
    }
    for (const id of ["not-an-id", "abcdef", "ffffffff-ffff-7fff-8fff-ffffffffffff", cursor.id.slice(0, 8)]) {
      let lookupError: unknown;
      try {
        activity.getById(id);
      } catch (error) {
        lookupError = error;
      }
      expect(lookupError).toBeDefined();
      expect(() => activity.getAll({ startingAfter: id, sessionId: "absent", limit: 1 })).toThrow();
    }
    expect(activity.getAll({ startingAfter: events.at(-1)!.id, limit: 1 }))
      .toEqual({ events: [], hasMore: false });
  });
});
