import type { Database as WriterConnection } from "bun:sqlite";
import type { SqliteParams } from "../../core/src/sqlite/database.js";
import type { Command } from "./types.js";

import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activity, column, comment, label, project, readSnapshot, relation, task,
} from "@zinn-dev/core";
import { getDb } from "../../core/src/db.js";
import { Database } from "../../core/src/sqlite/database.js";
import { withTestStore } from "../../core/src/testing.js";
import { withTestDb } from "../test-helpers.js";
import * as follow from "./follow.js";
import * as output from "./lib.js";
import { doctorSchema } from "./result-schemas.js";
import { parsedRoutes } from "./routes/routes.js";

const actor = { kind: "human", name: "Snapshot test", email: null } as const;
const projectByKey = /SELECT \* FROM project WHERE key = \$key/;
const taskByNumber = /AND number = \$number/;

/** Interrupts a completed SELECT, before the next statement on the reading connection. */
function betweenReads<T>(match: RegExp, commit: () => void, read: () => T): T {
  const query = Database.prototype.query;
  let didCommit = false;
  const hook = spyOn(Database.prototype, "query").mockImplementation(function <Row, Params extends SqliteParams>(
    this: Database,
    sql: string,
  ) {
    const typedQuery = query<Row, Params>;
    const statement = typedQuery.call(this, sql);
    if (didCommit || !match.test(sql)) {
      return statement;
    }

    return new Proxy(statement, {
      get(target, name, receiver) {
        if (name !== "get" && name !== "all") {
          return Reflect.get(target, name, receiver);
        }

        return (...bindings: Parameters<typeof statement.get>) => {
          const result = target[name](...bindings);
          didCommit = true;
          commit();
          return result;
        };
      },
    });
  });

  try {
    const result = read();
    expect(didCommit).toBe(true);
    return result;
  } finally {
    hook.mockRestore();
  }
}

function commitIn(directory: string, write: (db: WriterConnection) => void) {
  withTestDb(directory, (db) => db.transaction(() => write(db))());
}

function seedStore(directory: string) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
  const app = project.create({ key: "APP", name: "Before project" }, actor);
  label.create({ name: "urgent", color: "red" }, actor);
  const main = task.create({ project_id: app.id, title: "Snapshot task", labelNames: ["urgent"] }, actor);
  const linked = task.create({ project_id: app.id, title: "Linked task" }, actor);
  comment.create({ taskKey: main.key, text: "Before comment" }, actor);
  relation.create({ sourceTaskKey: main.key, targetTaskKey: linked.key, relation_type: "related" }, actor);
  const extraColumn = column.create({ projectKey: app.key, name: "Before column", category: "todo" }, actor);
  const columnEvent = activity.getAll({ actions: ["create"] }).events.find(({ entity_id }) => entity_id === extraColumn.id)!;
  return { main, linked, extraColumn, columnEvent };
}

type Fixture = ReturnType<typeof seedStore>;
type Mode = ReturnType<typeof output.getOutputMode>;

function command(name: string): Command["run"] {
  return parsedRoutes.find((route) => route.command === name)!.run;
}

function captureRead(name: string, args: Array<string>, mode: Mode) {
  const originalMode = output.getOutputMode();
  const originalExitCode = process.exitCode;
  const originalForceColor = process.env.FORCE_COLOR;
  const printed: Array<string> = [];
  const print = spyOn(console, "info").mockImplementation((text: string) => {
    expect(getDb().inTransaction).toBe(false);
    printed.push(text);
  });
  output.setOutputMode(mode);
  if (mode === "text") {
    process.env.FORCE_COLOR = "1";
  }
  try {
    expect(command(name)(args)).toBeUndefined();
    expect(printed).toHaveLength(1);
    return mode === "json" ? JSON.parse(printed[0]!) : printed[0];
  } finally {
    print.mockRestore();
    output.setOutputMode(originalMode);
    process.exitCode = originalExitCode ?? 0;
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
  }
}

function expectSnapshots<T>(read: () => T, match: RegExp, commit: () => void) {
  const before = read();
  const during = betweenReads(match, commit, read);
  expect(during).toEqual(before);
  const after = read();
  expect(after).not.toEqual(before);
}

function renameBacklog(db: WriterConnection) {
  db.run("UPDATE project_column SET name = 'After backlog' WHERE name = 'Backlog'");
}

function renameColumn(db: WriterConnection, { extraColumn }: Fixture) {
  db.run("UPDATE project_column SET name = 'After column' WHERE id = ?", [extraColumn.id]);
}

function editComment(db: WriterConnection) {
  db.run("UPDATE comment SET text = 'After comment'");
}

function recordEdit(db: WriterConnection, { main }: Fixture) {
  db.run("UPDATE task SET title = 'After task' WHERE id = ?", [main.id]);
  db.run(
    `INSERT INTO activity (id, created_at, actor_kind, entity_type, entity_id, action, changes)
     VALUES (?, ?, 'human', 'task', ?, 'edit', ?)`,
    [crypto.randomUUID(), Date.now(), main.id, JSON.stringify({ title: [main.title, "After task"] })],
  );
}

const reads: Array<{
  name: string;
  args: (fixture: Fixture) => Array<string>;
  mode?: Mode;
  match: RegExp;
  write: (db: WriterConnection, fixture: Fixture) => void;
}> = [
  { name: "task list", args: () => [], match: projectByKey, write: renameBacklog },
  { name: "task search", args: () => ["Snapshot"], match: projectByKey, write: renameBacklog },
  { name: "task next", args: () => [], match: projectByKey, write: renameBacklog },
  { name: "task view", args: () => ["APP-1", "--history"], match: taskByNumber, write: recordEdit },
  { name: "task view", args: () => ["APP-1", "--history"], mode: "text", match: taskByNumber, write: recordEdit },
  {
    name: "task list", args: () => [], mode: "text", match: /SELECT attachment.task_id, label.\*/,
    write: (db) => db.run("UPDATE label SET color = 'green'"),
  },
  {
    name: "task blame", args: () => ["APP-1"], mode: "text", match: taskByNumber,
    write: (db, fixture) => {
      recordEdit(db, fixture);
      db.run("UPDATE task SET archived_at = ? WHERE id = ?", [Date.now(), fixture.main.id]);
    },
  },
  { name: "task relation list", args: () => ["APP-1"], match: taskByNumber, write: renameBacklog },
  { name: "task comment list", args: () => ["APP-1"], match: taskByNumber, write: editComment },
  { name: "task comment view", args: () => ["APP-1#1"], match: taskByNumber, write: editComment },
  {
    name: "project list", args: () => [], match: /GROUP BY project_id/,
    write: (db, fixture) => {
      db.run("UPDATE project SET name = 'After project'");
      db.run("UPDATE task SET archived_at = ? WHERE id = ?", [Date.now(), fixture.main.id]);
    },
  },
  { name: "project view", args: () => [], match: projectByKey, write: renameBacklog },
  { name: "project column list", args: () => [], match: projectByKey, write: renameBacklog },
  {
    name: "activity list", args: () => ["--task", "APP-1"], match: taskByNumber, write: recordEdit,
  },
  {
    name: "activity list", args: () => ["--action", "create"], mode: "text",
    match: /SELECT \* FROM activity WHERE action IN/, write: renameColumn,
  },
  {
    name: "activity view", args: ({ columnEvent }) => [columnEvent.id], mode: "text",
    match: /SELECT \* FROM activity\s+WHERE id >=/, write: renameColumn,
  },
];

for (const { name, args, mode = "json", match, write } of reads) {
  test(`${name} (${mode}) retains one read snapshot through a second connection's commit`, () => {
    withTestStore((directory) => {
      const fixture = seedStore(directory);
      expectSnapshots(
        () => captureRead(name, args(fixture), mode),
        match,
        () => commitIn(directory, (db) => write(db, fixture)),
      );
    });
  });
}

test("doctor classifies and checks tables on one inspection snapshot", () => {
  withTestStore((directory) => {
    seedStore(directory);
    const read = () => doctorSchema.parse(captureRead("doctor", [], "json"))
      .checks.map(({ id, status }) => [id, status]);
    const before = read();
    expect(before).toContainEqual(["search_index", "ok"]);
    const during = betweenReads(/SELECT COUNT\(\*\) AS count FROM sqlite_schema/, () => {
      commitIn(directory, (db) => {
        db.run("PRAGMA user_version = 1000");
        db.run("DELETE FROM task_search");
      });
    }, read);
    expect(during).toEqual(before);
    const after = read();
    expect(after).toContainEqual(["database", "problem"]);
    expect(after.some(([id]) => id === "search_index")).toBe(false);
  });
});

test("a composed core read shares the snapshot and releases it on return or error", () => {
  withTestStore((directory) => {
    const fixture = seedStore(directory);
    const read = () => readSnapshot(() => ({
      task: task.getByKey(fixture.main.key),
      comments: comment.getAll(fixture.main.key),
    }));
    expectSnapshots(read, taskByNumber, () => commitIn(directory, editComment));
    const failure = new Error("failed snapshot callback");
    expect(() => readSnapshot(() => { throw failure; })).toThrow(failure);
    expect(getDb().inTransaction).toBe(false);
    expect(() => readSnapshot(() => Promise.resolve(1))).toThrow(TypeError);
    expect(getDb().inTransaction).toBe(false);
    expect(read().comments[0]?.text).toBe("After comment");
  });
});

const coreReads: Array<{
  name: string;
  read: (fixture: Fixture) => unknown;
  match: RegExp;
  write: (db: WriterConnection, fixture: Fixture) => void;
}> = [
  {
    name: "task.getAll", read: () => task.getAll({ projectKey: "APP" }),
    match: projectByKey, write: recordEdit,
  },
  {
    name: "task.getByKey", read: ({ main }) => task.getByKey(main.key),
    match: projectByKey, write: recordEdit,
  },
  {
    name: "task.search", read: () => task.search({ query: "Snapshot", projectKey: "APP" }),
    match: projectByKey, write: recordEdit,
  },
  {
    name: "task.label.getAll", read: ({ main }) => task.label.getAll(main.key),
    match: taskByNumber, write: (db) => db.run("UPDATE label SET name = 'After label'"),
  },
  {
    name: "task.activity", read: ({ main }) => task.activity(main.key),
    match: taskByNumber, write: recordEdit,
  },
  {
    name: "relation.getAll", read: ({ main }) => relation.getAll(main.key, { include: { tasks: true } }),
    match: taskByNumber, write: (db) => db.run("UPDATE task SET title = 'After title'"),
  },
  {
    name: "relation.getConflicts",
    read: ({ main, linked }) =>
      relation.getConflicts({
        sourceTaskKey: main.key,
        targetTaskKey: linked.key,
        relation_type: "dependency",
      }),
    match: taskByNumber,
    write: (db) => db.run("UPDATE task SET title = 'After title'"),
  },
  {
    name: "column.getByName", read: () => column.getByName("APP", "Backlog"),
    match: projectByKey, write: (db) => db.run("UPDATE project_column SET category = 'todo'"),
  },
  {
    name: "column.getAllByProjectKey", read: () => column.getAllByProjectKey("APP"),
    match: projectByKey, write: renameBacklog,
  },
  {
    name: "column.getTaskCountsByProjectKey", read: () => column.getTaskCountsByProjectKey("APP"),
    match: /SELECT column_id, COUNT/, write: (db) => db.run("UPDATE task SET archived_at = 1"),
  },
  {
    name: "activity.getTaskIdentities",
    read: ({ main }) => activity.getTaskIdentities({ taskKey: main.key, showDeleted: true }),
    match: taskByNumber,
    write: (db, { main }) => {
      const deletedId = crypto.randomUUID();
      db.run(
        `INSERT INTO activity (id, created_at, actor_kind, entity_type, entity_id, action, changes)
         VALUES (?, ?, 'human', 'task', ?, 'delete', ?)`,
        [crypto.randomUUID(), Date.now(), deletedId, JSON.stringify({ key: main.key, title: "Deleted task" })],
      );
    },
  },
  {
    name: "activity.getCurrentTaskIdentities",
    read: ({ main, linked }) => activity.getCurrentTaskIdentities({ taskIds: [linked.id], taskKeys: [main.key] }),
    match: /task.id IN \(SELECT value FROM json_each\(\$taskIds\)\)/,
    write: recordEdit,
  },
];

for (const { name, match, read, write } of coreReads) {
  test(`${name} retains its own read snapshot`, () => {
    withTestStore((directory) => {
      const fixture = seedStore(directory);
      expectSnapshots(
        () => read(fixture),
        match,
        () => commitIn(directory, (db) => write(db, fixture)),
      );
    });
  });
}

test("activity follow releases each poll before output and reads commits made during the previous poll", async () => {
  const polls = withTestStore((directory) => {
    const fixture = seedStore(directory);
    const signal = new AbortController().signal;
    const chunks: Array<string> = [];
    let poll!: (signal: AbortSignal) => void | Promise<void>;
    const loop = spyOn(follow, "followUntilStopped").mockImplementation((run) => {
      poll = run;
      return Promise.resolve();
    });
    const stream = spyOn(output, "outputStream").mockImplementation(async (events, format) => {
      expect(getDb().inTransaction).toBe(false);
      chunks.push(format(events));
    });
    const originalMode = output.getOutputMode();
    output.setOutputMode("text");
    const insertColumnEvent = (db: WriterConnection) => {
      db.run(
        `INSERT INTO activity (id, created_at, actor_kind, entity_type, entity_id, action, changes)
         VALUES (?, ?, 'human', 'column', ?, 'edit', '{}')`,
        [crypto.randomUUID(), Date.now(), fixture.extraColumn.id],
      );
    };
    try {
      const following = command("activity list")(["--follow"]);
      commitIn(directory, insertColumnEvent);
      const first = betweenReads(/rowid > \$afterPosition/, () => {
        commitIn(directory, (db) => {
          renameColumn(db, fixture);
          insertColumnEvent(db);
        });
      }, () => poll(signal));
      const second = poll(signal);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("Before column");
      expect(chunks[0]).not.toContain("After column");
      expect(chunks[1]).toContain("After column");
      return [following, first, second];
    } finally {
      output.setOutputMode(originalMode);
      stream.mockRestore();
      loop.mockRestore();
    }
  });
  await Promise.all(polls);
});
