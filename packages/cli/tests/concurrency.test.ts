import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "../test-helpers";

// Short enough to keep the timeout case cheap, long enough to tell waiting from failing at once.
const SHORT_BUSY_TIMEOUT_MS = 1_000;
// Leaves room for CLI startup and other tests running at the same time.
const BUSY_FAILURE_LIMIT_MS = 10_000;

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (let round = 0; round < 3; round++) {
      const store = join(dir, `list-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, () =>
        runZinn(["project", "list", "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // ZINN-458: readers of a store without a database report it and create nothing.
      for (const result of results) {
        expect(result.code).toBe(1);
        expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
      }
      expect(withoutTelemetry(readdirSync(store))).toEqual([]);
    }

    for (let round = 0; round < 3; round++) {
      const store = join(dir, `mixed-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        runZinn(index % 2 === 0
          ? ["project", "list", "--json"]
          : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // A reader that loses the race with the creating writer reports the missing database.
      for (const [index, result] of results.entries()) {
        if (index % 2 === 1 || result.code === 0) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        } else {
          expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
        }
      }
      withTestDb(store, (db) => {
        expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: 20 });
        expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      });
    }

    for (const operation of ["create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        mkdirSync(store);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinn(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
        ));

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        }
        withTestDb(store, (db) => {
          const expectedProjects = operation === "create" ? 40 : 0;
          expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: expectedProjects });
          expect(db.query("SELECT COUNT(*) AS count FROM project_column").get()).toEqual({ count: expectedProjects * 6 });
          expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: expectedProjects });
          expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        });
      }
    }
  });
}, 60_000);

test("concurrent task and comment writes preserve results, counters, order, activity and search", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BEN"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BEN", "--title", "comment-target"], dir)).code).toBe(0);
    const taskKeys = ["BEN-1"];
    const commentKeys: Array<string> = [];
    const titles = ["comment-target"];
    const comments: Array<string> = [];

    for (let round = 0; round < 3; round++) {
      const operations = [
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "task", token: `task${round}n${index}` })),
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "comment", token: `comment${round}n${index}` })),
        ...Array.from({ length: 20 }, () => ({ kind: "read", token: "" })),
      ];
      const results = await Promise.all(operations.map(async ({ kind, token }) => {
        const args = kind === "task" ? ["task", "create", "BEN", "--title", token, "--json"]
          : kind === "comment" ? ["task", "comment", "create", "BEN-1", "--text", token, "--json"]
          : ["task", "list", "BEN", "--json"];
        return { kind, token, ...await runZinn(args, dir, { AI_AGENT: "concurrency-test" }) };
      }));

      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const data = JSON.parse(result.stdout);
        if (result.kind === "task") {
          taskKeys.push(data.key);
          titles.push(result.token);
        } else if (result.kind === "comment") {
          commentKeys.push(data.key);
          comments.push(result.token);
        } else {
          expect(Array.isArray(data)).toBe(true);
        }
      }
    }

    expect(new Set(taskKeys).size).toBe(titles.length);
    expect(new Set(commentKeys).size).toBe(comments.length);
    withTestDb(dir, (db) => {
      const tasks = db.query<{ id: string; number: number; title: string; task_order: string; comment_count: number }, []>(
        "SELECT id, number, title, task_order, comment_count FROM task ORDER BY number",
      ).all();
      const storedComments = db.query<{ number: number; text: string }, []>(
        "SELECT number, text FROM comment ORDER BY number",
      ).all();
      expect(tasks.map((task) => task.title).sort()).toEqual([...titles].sort());
      expect(tasks.map((task) => task.number)).toEqual(Array.from({ length: titles.length }, (_, index) => index + 1));
      expect(new Set(tasks.map((task) => task.task_order)).size).toBe(tasks.length);
      expect(storedComments.map((comment) => comment.text).sort()).toEqual([...comments].sort());
      expect(storedComments.map((comment) => comment.number)).toEqual(Array.from({ length: comments.length }, (_, index) => index + 1));
      expect(tasks[0]!.comment_count).toBe(comments.length);
      expect(db.query("SELECT task_count FROM project WHERE key = 'BEN'").get()).toEqual({ task_count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE entity_type = 'task' AND action = 'create'").get()).toEqual({ count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE action = 'comment_create'").get()).toEqual({ count: comments.length });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: tasks.length });

      for (const task of tasks) {
        expect(db.query("SELECT title FROM task_search WHERE task_id = ?").get(task.id)).toEqual({ title: task.title });
      }
      for (const token of comments) {
        expect(db.query("SELECT task_id FROM task_search WHERE task_search MATCH ?").all(token)).toEqual([{ task_id: tasks[0]!.id }]);
      }
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
}, 60_000);

test.serial("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "WAIT"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinn(["task", "create", "WAIT", "--title", "waited", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).key).toBe("WAIT-1");
      expect(performance.now() - began).toBeGreaterThanOrEqual(250);
      expect(db.query("SELECT title FROM task").all()).toEqual([{ title: "waited" }]);
    } finally {
      clearTimeout(release);
      if (db.inTransaction) {
        db.run("ROLLBACK");
      }
      db.close();
    }
  });
}, 45_000);

test("persistent contention times out after the busyTimeoutMs setting without a partial CLI mutation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ busyTimeoutMs: SHORT_BUSY_TIMEOUT_MS }));
    expect((await runZinn(["project", "create", "LOCK"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinn(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const busy = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(busy).toMatchObject({ code: "storage", details: { reason: "busy", cause: { code: "SQLITE_BUSY" } } });
      expect(readFileSync(busy.details!.logPath!, "utf8")).toContain(busy.details!.cause!.code!);
      expect(performance.now() - began).toBeGreaterThanOrEqual(SHORT_BUSY_TIMEOUT_MS);
      expect(performance.now() - began).toBeLessThan(BUSY_FAILURE_LIMIT_MS);
      expect(db.query("SELECT COUNT(*) AS count FROM task").get()).toEqual({ count: 0 });
      expect(db.query("SELECT task_count FROM project WHERE key = 'LOCK'").get()).toEqual({ task_count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: 1 });
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
  });
});

test("simultaneous backup commands create distinct valid snapshots", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BAK"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BAK", "--title", "Saved"], dir)).code).toBe(0);

    const results = await Promise.all(Array.from({ length: 4 }, () => runZinn(["backup", "--json"], dir, { AI_AGENT: "concurrency-test" })));
    const paths = new Set<string>();
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const { path } = JSON.parse(result.stdout) as { path: string };
      expect(paths.has(path)).toBe(false);
      paths.add(path);
      const snapshot = new Database(path, { readonly: true });
      try {
        expect(snapshot.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
        expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    }
  });
});
