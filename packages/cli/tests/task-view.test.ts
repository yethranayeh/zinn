import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { dim, runZinn, runZinnInTerminal, SECTION_RULE, taskViewContent, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task view exposes stored timestamps after its content and history, using local UTC offsets", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir, { TZ: "Europe/Berlin" });
    expect((await run("project", "create", "TIME")).code).toBe(0);
    const created = await run("task", "create", "TIME", "--title", "Timestamped", "--description", "Details", "--json");
    expect(created.code).toBe(0);
    expect((await run("task", "create", "TIME", "--title", "Other")).code).toBe(0);
    expect((await run("task", "comment", "create", "TIME-1", "--text", "A comment")).code).toBe(0);
    expect((await run("task", "relation", "create", "TIME-1", "TIME-2", "--type", "related")).code).toBe(0);
    const createdAt = Date.UTC(2026, 0, 15, 10, 7);
    const updatedAt = Date.UTC(2026, 6, 15, 9, 42);
    withTestDb(dir, (db) => {
      db.run("UPDATE task SET created_at = ?, updated_at = ? WHERE number = 1", [createdAt, updatedAt]);
    });
    const activityBefore = (await run("activity", "list", "--project", "TIME", "--json")).stdout;

    for (const history of [[], ["--history"]]) {
      const viewed = await run("task", "view", "TIME-1", ...history);
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      const lastLine = viewed.stdout.trimEnd().split("\n").at(-1)!;
      expect(lastLine).toContain("Task");
      expect(lastLine).toContain("2026-01-15 11:07 +01:00");
      expect(lastLine).toContain("2026-07-15 11:42 +02:00");
      const json = await run("task", "view", "TIME-1", ...history, "--json");
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ created_at: createdAt, updated_at: updatedAt });
    }
    expect((await run("activity", "list", "--project", "TIME", "--json")).stdout).toBe(activityBefore);

    const createdTask = JSON.parse(created.stdout);
    expect(Number.isInteger(createdTask.created_at)).toBe(true);
    expect(Number.isInteger(createdTask.updated_at)).toBe(true);
    expect(createdTask.created_at).toBe(createdTask.updated_at);
    for (const result of [
      JSON.parse((await run("task", "list", "TIME", "--json")).stdout)[0],
      JSON.parse((await run("task", "search", "Timestamped", "TIME", "--json")).stdout)[0],
      JSON.parse((await run("task", "edit", "TIME-1", "--title", "Timestamped", "--json")).stdout),
    ]) {
      expect(result).toMatchObject({ created_at: createdAt, updated_at: updatedAt });
    }

    expect((await run("task", "comment", "create", "TIME-1", "--text", "Another comment")).code).toBe(0);
    expect((await run("task", "relation", "delete", "TIME-1", "TIME-2", "--type", "related")).code).toBe(0);
    const unchanged = JSON.parse((await run("task", "view", "TIME-1", "--json")).stdout);
    expect(unchanged).toMatchObject({ created_at: createdAt, updated_at: updatedAt });
    expect((await run("task", "edit", "TIME-1", "--title", "Changed")).code).toBe(0);
    const changed = JSON.parse((await run("task", "view", "TIME-1", "--json")).stdout);
    expect(changed.created_at).toBe(createdAt);
    expect(changed.updated_at).toBeGreaterThan(updatedAt);
    expect(withTestDb(dir, (db) => db.query("SELECT updated_at FROM task WHERE number = 1").get()))
      .toEqual({ updated_at: changed.updated_at });
  });
});

test("task view prints the task row followed by Description, Relations, and Comments sections", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir, { TZ: "Europe/Berlin" });
    const description = "First line of the description.\nSecond line.";
    await run("project", "create", "MDR");
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("task", "create", "MDR", "--title", "Refine the numbers", "--description", description, "--priority", "high", "--label", "cli", "--label", "bug");
    await run("task", "create", "MDR", "--title", "Check the totals");
    await run("task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    await run("task", "comment", "create", "MDR-1", "--text", "Ready for review");
    await run("task", "move", "MDR-1", "In Progress");
    const commentedAt = Date.UTC(2026, 8, 25, 17, 42);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ?", [commentedAt, commentedAt]);
    });

    const viewed = await run("task", "view", "MDR-1");

    expect(viewed.code).toBe(0);
    expect(viewed.stderr).toBe("");
    expect(taskViewContent(viewed.stdout)).toBe(
      [
        "MDR-1 | In Progress | High | Refine the numbers | bug, cli",
        "",
        SECTION_RULE,
        "Description:",
        "First line of the description.",
        "Second line.",
        "",
        SECTION_RULE,
        "Relations:",
        "Depends on | MDR-2 | Backlog | Check the totals",
        "",
        SECTION_RULE,
        "Comments:",
        "MDR-1#1 | 2026-09-25 19:42 +02:00 | Ready for review",
        "",
      ].join("\n"),
    );

    expect(JSON.parse((await run("task", "view", "MDR-1", "--json")).stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "MDR-1",
      status: "Active",
      column: "In Progress",
      is_first: false,
      is_last: false,
      title: "Refine the numbers",
      description,
      priority: "high",
      due_at: null,
      labels: ["bug", "cli"],
      label_ids: [expect.any(String), expect.any(String)],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      relations: [
        {
          id: expect.any(String),
          type: "dependency",
          direction: "outgoing",
          task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "MDR-2", column: "Backlog", is_first: true, is_last: false, title: "Check the totals", status: "Active" },
        },
      ],
      comments: [
        { id: expect.any(String), task_id: expect.any(String), key: "MDR-1#1", text: "Ready for review", created_at: commentedAt, updated_at: commentedAt },
      ],
    });
  });
});

test("task view leaves out the Description section for a task without a description", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "title only"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "other task"], testDir);

    const result = await runZinn(["task", "view", "NONE-1"], testDir);

    expect(result.code).toBe(0);
    expect(taskViewContent(result.stdout)).toBe(`NONE-1 | Backlog | - | title only\n`);

    await runZinn(["task", "relation", "create", "NONE-1", "NONE-2", "--type", "related"], testDir);
    expect(taskViewContent((await runZinn(["task", "view", "NONE-1"], testDir)).stdout)).toBe(
      `NONE-1 | Backlog | - | title only\n\n${SECTION_RULE}\nRelations:\nRelated to | NONE-2 | Backlog | other task\n`,
    );
  });
});

test.serial("task view sizes section rules to the terminal even when color is disabled", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "W"], dir);
    const description = "中文 🧑‍🌾\n  Keep this indentation";
    await runZinn(["task", "create", "W", "--title", "Width", "--description", description], dir);
    await runZinn(["task", "create", "W", "--title", "Other"], dir);
    await runZinn(["task", "relation", "create", "W-1", "W-2", "--type", "related"], dir);
    await runZinn(["task", "comment", "create", "W-1", "--text", "A comment"], dir);

    const colorEnvironments: Array<Record<string, string>> = [
      { FORCE_COLOR: "1" },
      { NO_COLOR: "1", FORCE_COLOR: "0" },
    ];
    for (const columns of [20, 80, 160]) {
      for (const env of colorEnvironments) {
        const result = await runZinnInTerminal(["task", "view", "W-1"], dir, env, columns);
        expect(result.code).toBe(0);
        const rule = "-".repeat(columns);
        const expectedRule = env.FORCE_COLOR === "1" ? dim(rule) : rule;
        const rules = result.output.split("\n").filter((line) => line === expectedRule);
        expect(rules).toHaveLength(3);
        expect(result.output).toContain(description);
      }
    }

    const piped = await runZinn(["task", "view", "W-1"], dir, { COLUMNS: "160", FORCE_COLOR: "0" });
    expect(piped.stdout.split("\n").filter((line) => line === SECTION_RULE)).toHaveLength(3);
  });
});

test("task view of an archived task shows Archived after the key and full priority", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "MDR");
    await run("label", "create", "bug");
    await run("task", "create", "MDR", "--title", "Refine the numbers", "--description", "Shelved", "--priority", "high", "--label", "bug");
    await run("task", "archive", "MDR-1");

    const archivedRow = "MDR-1 | Archived | Backlog | H | Refine the numbers | bug";
    expect((await run("task", "list", "MDR", "--all")).stdout).toBe(`${archivedRow}\n`);
    expect(taskViewContent((await run("task", "view", "MDR-1")).stdout)).toBe(`MDR-1 | Archived | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`);

    await run("task", "unarchive", "MDR-1");
    expect(taskViewContent((await run("task", "view", "MDR-1")).stdout)).toBe(
      `MDR-1 | Backlog | High | Refine the numbers | bug\n\n${SECTION_RULE}\nDescription:\nShelved\n`,
    );
  });
});

test("human task output omits empty descriptions while JSON returns null", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty description"], testDir);

    const created = await runZinn(
      ["task", "create", "EMPTY", "--title", "Empty description", "--description", ""],
      testDir,
    );
    expect(created.stdout).toBe(`EMPTY-1 | Backlog | - | Empty description\n`);

    expect((await runZinn(["task", "list", "EMPTY"], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect((await runZinn(["task", "search", "Empty", "EMPTY"], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(taskViewContent((await runZinn(["task", "view", "EMPTY-1"], testDir)).stdout)).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    await runZinn(["task", "edit", "EMPTY-1", "--description", "Visible"], testDir);
    expect((await runZinn(["task", "edit", "EMPTY-1", "--description", ""], testDir)).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );

    expect(JSON.parse((await runZinn(["task", "list", "EMPTY", "--json"], testDir)).stdout)).toEqual([
      expect.objectContaining({ key: "EMPTY-1", description: null }),
    ]);
  });
});

test("task view requires a task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "view"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: zinn task view");
  });
});

test("task view rejects malformed task keys with an actionable error", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const invalid = await runZinn(["--json", "task", "view", "VIEW-one"], testDir);

    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("VIEW-one"), details: { field: ["taskKey"] } });

    // ? ZINN-51: a word that begins with a dash is read as a word only after --.
    const dashKey = await runZinn(["--json", "task", "view", "--", "-1"], testDir);
    expect(dashKey.code).toBe(1);
    expect(dashKey.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(dashKey.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("-1"), details: { field: ["taskKey"] } });

  });
});

test("task view distinguishes an unknown project from an unknown task number", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KNOWN", "--name", "Known"], testDir);

    const unknownProject = await runZinn(["--json", "task", "view", "NOPE-1"], testDir);
    const unknownTask = await runZinn(["--json", "task", "view", "KNOWN-99"], testDir);

    expect(unknownProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownProject.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOPE" } });
    expect(unknownTask.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownTask.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "KNOWN-99" } });
  });
});
