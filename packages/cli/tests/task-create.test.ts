import { expect, test } from "bun:test";

import { errorDocumentSchema } from "../src/errors";
import { createEmptyDatabase, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task create rejects an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const result = await runZinn(["--json", "task", "create", "NOPE", "--title", "orphan task"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
  });
});

test("task create requires a project key and a title", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARGS", "--name", "Args"], testDir);

    expect((await runZinn(["task", "create"], testDir)).stderr).toContain("Usage: zinn task create");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "create", "ARGS"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--title" } });
  });
});

test("task create --column places the task last in the named column, matched case-insensitively", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "COLS", "--name", "Columns"], testDir);

    const first = await runZinn(["task", "create", "COLS", "--title", "first", "--column", "doing"], testDir);
    const second = await runZinn(["task", "create", "COLS", "--title", "second", "--column", "DOING"], testDir);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain("COLS-1 | Doing | - | first");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("COLS-2 | Doing | - | second");

    withTestDb(testDir, (db) => {
      const titles = db
        .query<{ title: string }, []>("SELECT title FROM task ORDER BY task_order")
        .all()
        .map((row) => row.title);

      expect(titles).toEqual(["first", "second"]);
    });
  });
});

test("task create --column rejects an unknown column and creates nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "BADCOL", "--name", "Bad column"], testDir);

    const rejected = await runZinn(["--json", "task", "create", "BADCOL", "--title", "nowhere", "--column", "Nowhere"], testDir);
    const repeated = await runZinn(["--json", "task", "create", "BADCOL", "--title", "twice", "--column", "Done", "--column", "TODO"], testDir);

    expect(rejected.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(rejected.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "column", key: "Nowhere" } });
    expect(repeated.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(repeated.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--column" } });
    expect((await runZinn(["task", "list", "BADCOL"], testDir)).stdout).toBe("");
    expect((await runZinn(["task", "create", "BADCOL", "--title", "real"], testDir)).stdout).toContain(
      "BADCOL-1 | Backlog | - | real",
    );
  });
});

test("task create relation flags relate the new task to existing tasks, from the new task's side", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    await run("project", "create", "APP", "--name", "App");
    await run("project", "create", "OTHER", "--name", "Other");
    for (const title of ["Epic", "Prerequisite", "Sibling", "Original"]) {
      await run("task", "create", "APP", "--title", title);
    }
    await run("task", "create", "OTHER", "--title", "Elsewhere");

    const created = await run(
      "task", "create", "APP", "--title", "Child",
      "--parent", "app-1", "--depends-on", "APP-2", "--depends-on", "OTHER-1",
      "--duplicate-of", "APP-4", "--related", "APP-3",
    );

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-5 | Backlog | - | Child\n");

    const childRelations = (await run("task", "relation", "list", "APP-5")).stdout;
    expect(childRelations).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+APP-2\s+\|\s+Backlog\s+\|\s+Prerequisite/);
    expect(childRelations).toMatch(/Depends on\s+\|\s+OTHER-1\s+\|\s+Backlog\s+\|\s+Elsewhere/);
    expect(childRelations).toMatch(/Duplicate of\s+\|\s+APP-4\s+\|\s+Backlog\s+\|\s+Original/);
    expect(childRelations).toMatch(/Related to\s+\|\s+APP-3\s+\|\s+Backlog\s+\|\s+Sibling/);
    expect((await run("task", "relation", "list", "APP-1")).stdout).toMatch(/Subtask\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "relation", "list", "APP-2")).stdout).toMatch(/Depended on by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "relation", "list", "APP-4")).stdout).toMatch(/Duplicated by\s+\|\s+APP-5\s+\|\s+Backlog\s+\|\s+Child/);
    expect((await run("task", "view", "APP-5")).stdout).toMatch(/Parent\s+\|\s+APP-1\s+\|\s+Backlog\s+\|\s+Epic/);

    withTestDb(testDir, (db) => {
      const actionsOf = (key: string) =>
        db
          .query<{ action: string }, [string]>(
            `SELECT activity.action FROM activity
             JOIN task ON task.id = activity.entity_id
             JOIN project ON project.id = task.project_id
             WHERE activity.entity_type = 'task' AND project.key || '-' || task.number = ?
             ORDER BY activity.id`,
          )
          .all(key)
          .map((row) => row.action);

      expect(actionsOf("APP-5")).toEqual([
        "create", "relation_create", "relation_create", "relation_create", "relation_create", "relation_create",
      ]);
      expect(actionsOf("APP-1")).toEqual(["create", "relation_create"]);
      expect(actionsOf("OTHER-1")).toEqual(["create", "relation_create"]);
    });
  });
});

test("task create rejects a missing, malformed or repeated relation target and creates nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: string[]) => runZinn(args, testDir);
    await run("project", "create", "APP", "--name", "App");
    await run("task", "create", "APP", "--title", "Epic");
    await run("task", "create", "APP", "--title", "Other epic");
    const countRows = () =>
      withTestDb(testDir, (db) =>
        db
          .query(
            "SELECT (SELECT COUNT(*) FROM task) AS tasks, (SELECT COUNT(*) FROM activity) AS activities, (SELECT COUNT(*) FROM task_relations) AS relations",
          )
          .get(),
      );
    const before = countRows();

    const missing = await run("--json", "task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--depends-on", "APP-99");
    const missingProject = await run("--json", "task", "create", "APP", "--title", "Lost", "--related", "NOPE-1");
    const malformed = await run("--json", "task", "create", "APP", "--title", "Lost", "--depends-on", "APP-1", "--related", "nope");
    const secondParent = await run("--json", "task", "create", "APP", "--title", "Lost", "--parent", "APP-1", "--parent", "APP-2");
    const secondDuplicate = await run("--json", "task", "create", "APP", "--title", "Lost", "--duplicate-of", "APP-1", "--duplicate-of", "APP-2");

    expect(missing.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(missing.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "APP-99" } });
    expect(missingProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(missingProject.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
    expect(malformed.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(malformed.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("nope"), details: { field: ["taskKey"] } });
    expect(secondParent.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(secondParent.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--parent" } });
    expect(secondDuplicate.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(secondDuplicate.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--duplicate-of" } });
    expect(countRows()).toEqual(before);
    expect((await run("task", "create", "APP", "--title", "Real")).stdout).toBe("APP-3 | Backlog | - | Real\n");
  });
});

test("task create help lists the relation flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const help = await runZinn(["task", "create", "--help"], testDir);

    expect(help.code).toBe(0);
    for (const flag of ["--parent <task-key>", "--depends-on <task-key>", "--duplicate-of <task-key>", "--related <task-key>"]) {
      expect(help.stdout).toContain(flag);
    }
  });
});

test("a project without columns rejects task creation without consuming a task number", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTYCOL", "--name", "No columns"], testDir);
    withTestDb(testDir, (db) => db.run("DELETE FROM project_column"));

    const rejected = await runZinn(["--json", "task", "create", "EMPTYCOL", "--title", "cannot place me"], testDir);

    expect(rejected.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(rejected.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "no_columns", entity: "project", key: "EMPTYCOL" } });

    await runZinn(["project", "column", "create", "--category", "todo", "EMPTYCOL", "Inbox"], testDir);
    expect((await runZinn(["task", "create", "EMPTYCOL", "--title", "first real task"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "view", "EMPTYCOL-1"], testDir)).stdout).toContain(
      "EMPTYCOL-1 | Inbox | - | first real task",
    );
  });
});
