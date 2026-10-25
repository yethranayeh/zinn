import { expect, spyOn, test } from "bun:test";
import { activity, project, task } from "../index";
import type { ActivityListInput } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { withTestStore } from "./testing";

const actor = { name: "Activity test", email: null, kind: "human" as const };

test("time bounds include ties, preserve original payloads and combine before the limit", () => {
  withTestStore(() => {
    const events = [99, 100, 101, 101, 102, 103].map((created_at, index) => dbActivity.create({
      created_at, actor_name: actor.name, actor_email: null, actor_kind: actor.kind,
      actor_source: null, actor_session_id: "Session", actor_thread_id: "Thread",
      actor_agent: null, actor_model: null, actor_effort: null,
      entity_type: index === 5 ? "label" : "task", entity_id: "historical", action: "edit",
      changes: { priority: [null, "high"], description: [null, `Full text ${index}\n`] },
    }));
    const before = activity.getAll();
    expect(activity.getAll({ since: 100 })).toEqual(before.filter(event => event.created_at >= 100));
    expect(activity.getAll({ until: 102 })).toEqual(before.filter(event => event.created_at <= 102));
    expect(activity.getAll({ since: 100, until: 102 })).toEqual(before.filter(event => event.created_at >= 100 && event.created_at <= 102));
    const tied = events.filter(event => event.created_at === 101).sort((left, right) => right.id.localeCompare(left.id));
    expect(activity.getAll({ since: 101, until: 101 })).toEqual(tied);
    expect(activity.getAll({ since: 101, until: 101, limit: 1 })).toEqual(tied.slice(0, 1));
    expect(activity.getAll({ since: 104 })).toEqual([]);
    expect(activity.getAll({ until: 98 })).toEqual([]);
    expect(activity.getAll({ since: 100, until: 102, sessionId: "Session", threadId: "Thread", actions: ["edit"], changed: [{ field: "priority", value: "high" }], limit: 1 }))
      .toEqual([events[4]!]);
    expect(activity.getAll({ since: 100, until: 102, threadId: "Other" })).toEqual([]);
    expect(activity.getAll()).toEqual(before);
    const db = getDb();
    db.exec("PRAGMA query_only = ON");
    const changes = db.query("SELECT total_changes() AS changes").get();
    expect(activity.getAll({ since: 101, until: 101 })).toEqual(tied);
    expect(db.query("SELECT total_changes() AS changes").get()).toEqual(changes);
  });
});

test("time filtering follows current, archived and historical identity resolution", () => {
  withTestStore(() => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const app = project.create({ key: "APP" }, actor);
      now = 10;
      const item = task.create({ project_id: app.id, title: "Original" }, actor);
      now = 20;
      task.edit({ taskKey: item.key, title: "Edited" }, actor);
      const edited = activity.getAll({ taskKey: item.key })[0]!;
      const query = (selector: ActivityListInput) => activity.getAll({ ...selector, since: 20, until: 20 });
      expect(query({ taskKey: item.key })).toEqual([edited]);
      now = 25;
      task.archive(item.key, actor);
      expect(query({ taskKey: item.key })).toEqual([edited]);
      now = 30;
      task.delete(item.key, actor);
      expect(query({ projectKey: app.key })).toEqual([edited]);
      now = 40;
      project.delete(app.key, actor);
      now = 50;
      const replacement = project.create({ key: "APP" }, actor);
      task.create({ project_id: replacement.id, title: "Replacement" }, actor);
      const before = activity.getAll();
      for (const selector of [
        { taskId: item.id }, { taskKey: item.key, showDeleted: true },
        { projectId: app.id }, { projectKey: app.key, showDeleted: true },
      ]) {
        expect(query(selector)).toEqual([edited]);
      }
      expect(query({ taskKey: item.key })).toEqual([]);
      expect(query({ projectKey: app.key })).toEqual([]);
      expect(activity.getAll()).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });
});
