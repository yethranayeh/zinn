import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task move requires a task key and target column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["task", "move"], testDir)).stderr).toContain("Usage: zinn task move");
    expect((await runZinn(["task", "move", "MOVE-1"], testDir)).stderr).toContain("Usage: zinn task move");
  });
});

test("task move help identifies its command with either help flag", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const longHelp = await runZinn(["task", "move", "--help"], testDir);
    const shortHelp = await runZinn(["task", "move", "-h"], testDir);

    expect(longHelp.code).toBe(0);
    expect(longHelp.stderr).toBe("");
    expect(longHelp.stdout).toContain("Usage: zinn task move <task-key>... <target-column>");
    expect(shortHelp.code).toBe(0);
    expect(shortHelp.stdout).toBe(longHelp.stdout);
  });
});

test("task move rejects a column outside the task's project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORIGIN", "--name", "Origin"], testDir);
    await runZinn(["project", "create", "OTHER", "--name", "Other"], testDir);
    await runZinn(["project", "column", "create", "OTHER", "External"], testDir);
    await runZinn(["task", "create", "ORIGIN", "--title", "stationary task"], testDir);

    const result = await runZinn(["--json", "task", "move", "ORIGIN-1", "External"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "column", key: "External" } });
    expect((await runZinn(["task", "view", "ORIGIN-1"], testDir)).stdout).toContain(
      `ORIGIN-1 | Backlog | - | stationary task`,
    );
  });
});

test("task move appends the task to the destination column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MOVE", "--name", "Movable"], testDir);
    await runZinn(["task", "create", "MOVE", "--title", "first task"], testDir);
    await runZinn(["task", "create", "MOVE", "--title", "second task"], testDir);

    expect((await runZinn(["task", "move", "MOVE-1", "In Progress"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "move", "MOVE-2", "In Progress"], testDir)).code).toBe(0);

    withTestDb(testDir, (db) => {
      const rows = db
        .query<
          {
            title: string;
            task_order: string;
            column_name: string;
            task_project: string;
            column_project: string;
          },
          []
        >(`SELECT task.title,
                  task.task_order,
                  project_column.name AS column_name,
                  task.project_id AS task_project,
                  project_column.project_id AS column_project
           FROM task
           JOIN project_column ON project_column.id = task.column_id
           ORDER BY task.task_order`)
        .all();

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.title)).toEqual(["first task", "second task"]);
      expect(rows.every((row) => row.column_name === "In Progress")).toBe(true);
      expect(rows.every((row) => row.task_project === row.column_project)).toBe(true);
      expect(rows[1]!.task_order > rows[0]!.task_order).toBe(true);
    });
  });
});

test("task move to the current column is a no-op", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "STILL", "--name", "Still"], testDir);
    await runZinn(["task", "create", "STILL", "--title", "still task"], testDir);

    const before = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    const result = await runZinn(["task", "move", "STILL-1", "Backlog"], testDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`STILL-1 | Backlog | - | still task\n`);

    const after = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    expect(after).toEqual(before);
  });
});

test("task move takes several tasks, appends them in argument order, and notes no-ops", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "MANY"], testDir);
    for (const title of ["one", "two", "three"]) {
      await runZinn(["task", "create", "MANY", "--title", title], testDir);
    }
    await runZinn(["task", "move", "MANY-1", "In Progress"], testDir);

    const result = await runZinn(["task", "move", "MANY-3", "MANY-1", "MANY-2", "In Progress"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "MANY-3 | In Progress | - | three\nMANY-1 | In Progress | - | one\nMANY-2 | In Progress | - | two\n",
    );
    expect(result.stderr).toContain("MANY-1");
    expect(result.stderr).toContain("In Progress");
    expect((await runZinn(["task", "list", "MANY"], testDir)).stdout).toMatch(
      /^MANY-1[^\n]*\nMANY-3[^\n]*\nMANY-2[^\n]*\n$/,
    );
  });
});

test("task move prints the task row, while --json returns the full task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "BRIEF"], testDir);
    await runZinn(
      ["task", "create", "BRIEF", "--title", "Detailed task", "--description", "Hidden from move output", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const moved = await runZinn(["task", "move", "BRIEF-1", "In Progress"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe("BRIEF-1 | In Progress | H | Detailed task | urgent\n");
    expect((await runZinn(["task", "list", "BRIEF"], testDir)).stdout).toBe(moved.stdout);

    const movedJson = await runZinn(["task", "move", "BRIEF-1", "Review", "--json"], testDir);
    expect(movedJson.code).toBe(0);
    expect(JSON.parse(movedJson.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "BRIEF-1",
      status: "Active",
      column: "Review",
      is_first: false,
      is_last: false,
      title: "Detailed task",
      description: "Hidden from move output",
      priority: "high",
      due_at: null,
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      changed: true,
    });
  });
});

test("task move prints the same row for one task and for several, as task list shows it", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "one", "--priority", "low"], testDir);
    await runZinn(["task", "create", "ROW", "--title", "two"], testDir);

    const movedOne = await runZinn(["task", "move", "ROW-1", "Done"], testDir);
    expect(movedOne.stdout).toBe("ROW-1 | Done | L | one\n");

    const movedSeveral = await runZinn(["task", "move", "ROW-2", "ROW-1", "In Progress"], testDir);
    expect(movedSeveral.stdout).toBe("ROW-2 | In Progress | - | two\nROW-1 | In Progress | L | one\n");
    expect(movedSeveral.stdout).toBe((await runZinn(["task", "list", "ROW"], testDir)).stdout);
  });
});

test("task move rejects archived tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCHMOVE", "--name", "Archived move"], testDir);
    await runZinn(["task", "create", "ARCHMOVE", "--title", "archived task"], testDir);
    await runZinn(["task", "archive", "ARCHMOVE-1"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    const result = await runZinn(["--json", "task", "move", "ARCHMOVE-1", "In Progress"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHMOVE-1" } });

    const after = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    expect(after).toEqual(before);
  });
});
