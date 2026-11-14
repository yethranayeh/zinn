import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { activity, backup, InputValidationError, project, task } from "../index";
import * as dbActivity from "./db/activity";
import { getDb } from "./db";
import { latestVersion, MIGRATIONS } from "./migrations/registry";
import { withTestStore } from "./testing";

// ZINN-328

const actor = { name: "Follow test", email: null, kind: "human" as const };
const TASK_ID = "11111111-1234-7000-8000-123456abcdef";

/** Commits through a second connection, as another process would */
function withOtherConnection(directory: string, write: (db: Database) => void) {
  const db = new Database(join(directory, "data", "zinn.sqlite"));
  try {
    write(db);
  } finally {
    db.close();
  }
}

function insertEvent(db: Database, id: string, createdAt: number, action = "edit") {
  db.run(
    "INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action) VALUES (?, ?, 'Other process', 'agent', 'task', ?, ?)",
    [id, createdAt, TASK_ID, action],
  );
}

function polledIds(follower: ReturnType<typeof activity.follow>) {
  const polled = follower.poll();
  if ("stopped" in polled) {
    throw new Error(`The follower stopped: ${polled.stopped}`);
  }
  return polled.events.map((event) => event.id);
}

test("a follower returns what other connections commit after it starts, in commit order and through its filters", () => {
  withTestStore((directory) => {
    const app = project.create({ key: "APP" }, actor);
    task.create({ project_id: app.id, title: "Before the follower" }, actor);
    const follower = activity.follow();
    const moves = activity.follow({ actions: ["move"] });

    expect(follower.poll()).toEqual({ events: [] });

    // The later commit carries the earlier timestamp, as when a writer waited for the write lock.
    withOtherConnection(directory, (db) => insertEvent(db, "00000000-0000-7000-8000-000000000002", 2_000));
    withOtherConnection(directory, (db) => insertEvent(db, "00000000-0000-7000-8000-000000000001", 1_000, "move"));

    expect(polledIds(follower)).toEqual(["00000000-0000-7000-8000-000000000002", "00000000-0000-7000-8000-000000000001"]);
    expect(polledIds(follower)).toEqual([]);
    expect(polledIds(moves)).toEqual(["00000000-0000-7000-8000-000000000001"]);

    withOtherConnection(directory, (db) => insertEvent(db, "00000000-0000-7000-8000-000000000003", 3_000));
    expect(polledIds(follower)).toEqual(["00000000-0000-7000-8000-000000000003"]);
    expect(polledIds(moves)).toEqual([]);
  });
});

test("a follower of a project includes a task created after it started and refuses a project that does not exist", () => {
  withTestStore((directory) => {
    const app = project.create({ key: "APP" }, actor);
    const other = project.create({ key: "OTH" }, actor);
    const follower = activity.follow({ projectKey: "APP" });
    expect(() => activity.follow({ projectKey: "NONE" })).toThrow();

    // The task rows and their events arrive from another connection, as a second process writes them.
    const created = task.create({ project_id: app.id, title: "Created after the follower started" }, actor);
    const elsewhere = task.create({ project_id: other.id, title: "Other project" }, actor);
    withOtherConnection(directory, (db) => {
      db.run("INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action) VALUES ('00000000-0000-7000-8000-00000000000a', 1, 'Other process', 'agent', 'task', ?, 'edit')", [created.id]);
      db.run("INSERT INTO activity (id, created_at, actor_name, actor_kind, entity_type, entity_id, action) VALUES ('00000000-0000-7000-8000-00000000000b', 2, 'Other process', 'agent', 'task', ?, 'edit')", [elsewhere.id]);
    });

    const polled = follower.poll();
    expect("events" in polled && polled.events.map((event) => event.entity_id)).toEqual([created.id, created.id]);
  });
});

test("a restore between the initial cursor read and schema read invalidates the follower", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, actor);
    const snapshot = backup.create({ client: "follow-test", version: "1.0.0" });
    task.create({ project_id: app.id, title: "After the snapshot" }, actor);
    const readPosition = dbActivity.readLastPosition;
    const positionRead = spyOn(dbActivity, "readLastPosition").mockImplementationOnce(() => {
      const position = readPosition();
      expect(getDb().inTransaction).toBe(true);
      backup.restore({ path: snapshot.path, client: "follow-test", version: "1.0.0" });
      return position;
    });

    try {
      const follower = activity.follow();
      expect(positionRead).toHaveBeenCalledTimes(1);
      expect(getDb().inTransaction).toBe(false);
      expect(follower.poll()).toMatchObject({ stopped: "schema_changed" });
    } finally {
      positionRead.mockRestore();
    }
  });
});

test("JavaScript callers cannot paginate a follower and its selection validation stays intact", () => {
  withTestStore(() => {
    project.create({ key: "APP" }, actor);
    const event = activity.getAll().events[0]!;
    for (const input of [
      { limit: 1 },
      { startingAfter: event.id },
      { since: 2, until: 1 },
      { projectKey: "APP", taskKey: "APP-1" },
      { showDeleted: true },
    ]) {
      expect(() => Reflect.apply(activity.follow, undefined, [input])).toThrow(InputValidationError);
    }
    expect(activity.getAll({ limit: 1, startingAfter: event.id }).events).toEqual([]);
  });
});

test("a follower stops when another connection changes the schema version or replaces tables", () => {
  for (const change of [
    `PRAGMA user_version = ${latestVersion(MIGRATIONS) + 1}`,
    "CREATE TABLE added_by_another_build (id TEXT)",
  ]) {
    withTestStore((directory) => {
      project.create({ key: "APP" }, actor);
      const follower = activity.follow();

      withOtherConnection(directory, (db) => insertEvent(db, "00000000-0000-7000-8000-000000000001", 1));
      expect(polledIds(follower)).toHaveLength(1);

      withOtherConnection(directory, (db) => db.run(change));
      const stopped = follower.poll();
      expect(stopped).toMatchObject({ stopped: "schema_changed" });
      expect("databasePath" in stopped && stopped.databasePath).toEndWith(join("data", "zinn.sqlite"));
    });
  }
});

test("a follower stops when the database path no longer leads to the file it opened", () => {
  withTestStore((directory) => {
    project.create({ key: "APP" }, actor);
    const follower = activity.follow();

    renameSync(join(directory, "data", "zinn.sqlite"), join(directory, "data", "moved.sqlite"));

    expect(follower.poll()).toMatchObject({ stopped: "file_replaced" });
  });
});
