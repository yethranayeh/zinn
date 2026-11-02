import { expect, test } from "bun:test";

import { activity, project, task } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { withTestStore } from "./testing";

const actor = { name: "Client test", email: null, kind: "human" as const };

test("client selection matches names and colon parts exactly across whitespace-separated chains", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const clients = [
      null, "zinn-cli/1", "zinn-cli/1 zinn-opencode/2", "zinn-cli/1 zinn-opencode:panel/2",
      "rex/3\tzinn-opencode:panel/4\nother/5", "Zinn-opencode/2", "zinn-opencode-extra/2",
      "wrapper/1/zinn-opencode", "zinn-opencode", "zinn-opencode:other/2", "",
    ];
    const events = clients.map((client, index) => {
      const item = task.create({ project_id: app.id, title: `Item ${index}` }, { ...actor, client });
      return task.activity(item.key)[0]!;
    }).toReversed();
    const rows = (client: string) => activity.getAll({ client }).events;
    expect(rows("zinn-opencode")).toEqual(events.filter((event) => [2, 3, 4, 8, 9].some(
      (index) => event.actor_client === clients[index],
    )));
    expect(rows("zinn-opencode:panel")).toEqual(events.filter((event) => [3, 4].some(
      (index) => event.actor_client === clients[index],
    )));
    expect(rows("Zinn-opencode")).toEqual(events.filter((event) => event.actor_client === clients[5]));
    for (const client of ["zinn", "opencode", "zinn-opencode/2", " zinn-opencode", "zinn-opencode "]) {
      expect(rows(client)).toEqual([]);
    }
    expect(() => rows("")).toThrow();
  });
});

test("sparse client matches fill pages in combination with identity, action and changed filters", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const item = task.create({ project_id: app.id, title: "Item" }, actor);
    const { id, ...template } = task.activity(item.key)[0]!;
    const events = Array.from({ length: 20 }, (_, index) => dbActivity.create({
      ...template, created_at: index, action: "edit",
      actor_client: index % 4 === 0 ? "zinn-cli/1 plugin:panel/2" : "zinn-cli/1",
      actor_session_id: "Session", actor_thread_id: "Thread",
      changes: { priority: [null, "high"] },
    })).toReversed();
    const filters = {
      taskKey: item.key, sessionId: "Session", threadId: "Thread", client: "plugin",
      actions: ["edit" as const], changed: [{ field: "priority" as const, value: "high" }],
      since: 0, until: 19,
    };
    const expected = events.filter((event) => event.actor_client!.includes("plugin"));
    let startingAfter: string | undefined;
    for (let offset = 0; offset < expected.length; offset += 2) {
      const page = activity.getAll({ ...filters, limit: 2, startingAfter });
      expect(page.events).toEqual(expected.slice(offset, offset + 2));
      expect(page.hasMore).toBe(offset + 2 < expected.length);
      startingAfter = page.nextCursor;
    }
    expect(activity.getAll(filters).events).toEqual(expected);
    expect(activity.getAll({ ...filters, client: "Plugin" }).events).toEqual([]);
    const nonmatchingCursor = events[1]!;
    expect(activity.getAll({ ...filters, startingAfter: nonmatchingCursor.id }).events).toEqual(
      expected.filter((event) => event.created_at < nonmatchingCursor.created_at),
    );
  });
});

test("read-only version 3 activity returns null clients and no client matches", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    getDb().exec("ALTER TABLE activity DROP COLUMN actor_client");
    getDb().exec("PRAGMA user_version = 3");
    getDb().exec("PRAGMA query_only = ON");
    const events = activity.getAll().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actor_client === null)).toBe(true);
    expect(activity.getById(events[0]!.id).actor_client).toBeNull();
    expect(activity.getAll({ client: "zinn-cli", limit: 1 })).toEqual({ events: [], hasMore: false });
  });
});
