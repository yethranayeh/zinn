import { expect, test } from "bun:test";

import { activity, actorSchema, project, task } from "../index";
import { getDb } from "./db";
import { withTestStore } from "./testing";

const actor = { name: "Directory test", email: null, kind: "human" as const };

test("activity records a declared directory as given and null when none is declared", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    for (const directory of ["/work/app", "C:\\work\\app", " /path with spaces/ ", undefined, null]) {
      const item = task.create({ project_id: app.id, title: "Item" }, { ...actor, directory });
      const [event] = task.activity(item.key);
      expect(event!.actor_directory).toBe(directory ?? null);
      expect(activity.getById(event!.id).actor_directory).toBe(directory ?? null);
      expect(task.blame(item.key).fields.title.attribution?.actor_directory).toBe(directory ?? null);
    }
    expect(() => actorSchema.parse({ ...actor, directory: "" })).toThrow();
  });
});

test("read-only version 7 activity returns null directories", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, { ...actor, directory: "/work/app" });
    getDb().exec("ALTER TABLE activity DROP COLUMN actor_directory");
    getDb().exec("PRAGMA user_version = 7");
    getDb().exec("PRAGMA query_only = ON");
    const events = activity.getAll().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actor_directory === null)).toBe(true);
  });
});
