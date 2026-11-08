import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { createEmptyDatabase, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task archive and unarchive take several tasks and note no-ops", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SHELF"], testDir);
    for (const title of ["one", "two", "three"]) {
      await runZinn(["task", "create", "SHELF", "--title", title], testDir);
    }
    await runZinn(["task", "archive", "SHELF-2"], testDir);

    const archived = await runZinn(["task", "archive", "SHELF-1", "SHELF-2"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "SHELF-1 | Archived | Backlog | - | one\nSHELF-2 | Archived | Backlog | - | two\n",
    );
    expect(archived.stderr).toContain("SHELF-2");

    const unarchived = await runZinn(["task", "unarchive", "SHELF-2", "SHELF-3", "SHELF-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stderr).toContain("SHELF-3");
    expect((await runZinn(["task", "list", "SHELF"], testDir)).stdout).toMatch(
      /^SHELF-3[^\n]*\nSHELF-2[^\n]*\nSHELF-1[^\n]*\n$/,
    );
  });
});

test("task archive and unarchive print the same row with status for one task and for several", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "one"], testDir);
    await runZinn(
      ["task", "create", "ROW", "--title", "two", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const archivedOne = await runZinn(["task", "archive", "ROW-2"], testDir);
    expect(archivedOne.stdout).toBe("ROW-2 | Archived | Backlog | H | two | urgent\n");

    const unarchivedOne = await runZinn(["task", "unarchive", "ROW-2"], testDir);
    expect(unarchivedOne.stdout).toBe("ROW-2 | Active | Backlog | H | two | urgent\n");

    const archivedSeveral = await runZinn(["task", "archive", "ROW-1", "ROW-2"], testDir);
    expect(archivedSeveral.stdout).toBe(
      "ROW-1 | Archived | Backlog | - | one\nROW-2 | Archived | Backlog | H | two | urgent\n",
    );
    expect(archivedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW", "--all"], testDir)).stdout);

    const unarchivedSeveral = await runZinn(["task", "unarchive", "ROW-1", "ROW-2"], testDir);
    expect(unarchivedSeveral.stdout).toBe(
      "ROW-1 | Active | Backlog | - | one\nROW-2 | Active | Backlog | H | two | urgent\n",
    );
    expect(unarchivedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW", "--all"], testDir)).stdout);
  });
});

test("task archive hides a task from active lists without deleting it", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCH", "--name", "Archive"], testDir);
    await runZinn(["task", "create", "ARCH", "--title", "kept task", "--description", "kept description"], testDir);
    await runZinn(["task", "move", "ARCH-1", "In Progress"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<
          {
            id: string;
            column_id: string;
            number: number;
            title: string;
            description: string;
            task_order: string;
            created_at: number;
            updated_at: number;
          },
          []
        >("SELECT * FROM task WHERE number = 1")
        .get(),
    )!;

    expect((await runZinn(["task", "archive", "aRcH-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "ARCH"], testDir)).stdout).toBe("");
    expect((await runZinn(["task", "list", "ARCH", "--archived"], testDir)).stdout).toContain(
      "ARCH-1 | In Progress | - | kept task",
    );
    expect((await runZinn(["task", "list", "--all", "ARCH"], testDir)).stdout).toContain("kept task");
    expect((await runZinn(["task", "view", "ARCH-1"], testDir)).stdout).toContain("kept task");

    withTestDb(testDir, (db) => {
      const after = db
        .query<
          typeof before & { archived_at: number },
          { $id: string }
        >("SELECT * FROM task WHERE id = $id")
        .get({ $id: before.id })!;

      expect(after.archived_at).toBeGreaterThan(0);
      expect(after.updated_at).toBe(after.archived_at);
      expect({
        id: after.id,
        column_id: after.column_id,
        number: after.number,
        title: after.title,
        description: after.description,
        task_order: after.task_order,
        created_at: after.created_at,
      }).toEqual({
        id: before.id,
        column_id: before.column_id,
        number: before.number,
        title: before.title,
        description: before.description,
        task_order: before.task_order,
        created_at: before.created_at,
      });
    });
  });
});

test("task list --all identifies active and archived tasks in a status column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MIXED", "--name", "Mixed archive"], testDir);
    await runZinn(["task", "create", "MIXED", "--title", "archived task"], testDir);
    await runZinn(["task", "create", "MIXED", "--title", "active task"], testDir);
    await runZinn(["task", "archive", "MIXED-1"], testDir);

    expect((await runZinn(["task", "list", "MIXED"], testDir)).stdout).toBe(
      `MIXED-2 | Backlog | - | active task\n`,
    );
    expect((await runZinn(["task", "list", "MIXED", "--archived"], testDir)).stdout).toBe(
      `MIXED-1 | Backlog | - | archived task\n`,
    );
    expect((await runZinn(["task", "list", "MIXED", "--all"], testDir)).stdout).toBe(
      [
        `MIXED-2 | Active   | Backlog | - | active task`,
        `MIXED-1 | Archived | Backlog | - | archived task`,
        "",
      ].join("\n"),
    );
  });
});

test("task unarchive appends the task after active tasks in its previous column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "RESTOREORDER", "--name", "Restore order"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "first task"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "second task"], testDir);
    await runZinn(["task", "create", "RESTOREORDER", "--title", "third task"], testDir);
    await runZinn(["task", "archive", "RESTOREORDER-1"], testDir);

    const archived = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect((await runZinn(["task", "unarchive", "RESTOREORDER-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "RESTOREORDER"], testDir)).stdout).toMatch(
      /RESTOREORDER-2[^\n]*\nRESTOREORDER-3[^\n]*\nRESTOREORDER-1/,
    );

    const restored = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect(restored.column_id).toBe(archived.column_id);
    expect(restored.task_order).not.toBe(archived.task_order);
  });
});

test("task unarchive help identifies its command and arguments", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "unarchive", "--help"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn task unarchive <task-key>...");
  });
});

test("task archive is idempotent and unarchive restores active listing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "RESTORE", "--name", "Restore"], testDir);
    await runZinn(["task", "create", "RESTORE", "--title", "restorable task"], testDir);
    await runZinn(["task", "archive", "RESTORE-1"], testDir);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET archived_at = 123, updated_at = 123 WHERE number = 1"),
    );
    expect((await runZinn(["task", "archive", "RESTORE-1"], testDir)).code).toBe(0);

    const stillArchived = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: number; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(stillArchived).toEqual({ archived_at: 123, updated_at: 123 });

    expect((await runZinn(["task", "unarchive", "RESTORE-1"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "RESTORE"], testDir)).stdout).toContain("restorable task");
    expect((await runZinn(["task", "list", "RESTORE", "--archived"], testDir)).stdout).toBe("");

    const restored = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: null; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(restored?.archived_at).toBeNull();
    expect(restored?.updated_at).toBeGreaterThan(123);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET updated_at = 1 WHERE number = 1"),
    );
    const beforeActiveUnarchive = withTestDb(testDir, (db) =>
      db
        .query<{ task_order: string; updated_at: number }, []>(
          "SELECT task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    expect((await runZinn(["task", "unarchive", "RESTORE-1"], testDir)).code).toBe(0);

    const afterActiveUnarchive = withTestDb(testDir, (db) =>
      db
        .query<{ task_order: string; updated_at: number }, []>(
          "SELECT task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(afterActiveUnarchive).toEqual(beforeActiveUnarchive);
  });
});

test("task archive and unarchive require a valid existing task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    expect((await runZinn(["task", "archive"], testDir)).stderr).toContain("Usage: zinn task archive");
    expect((await runZinn(["task", "unarchive"], testDir)).stderr).toContain("Usage: zinn task unarchive");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "archive", "INVALID"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("INVALID"), details: { field: ["taskKey"] } });
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "unarchive", "NOPE-1"], testDir)).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
  });
});
