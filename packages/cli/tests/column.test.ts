import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("project column delete confirms, validates and returns the deleted column", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "COL"], dir)).code).toBe(0);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    for (const [args, expected] of [
      [["COL", "Review"], { code: "invalid_input", details: { reason: "confirmation_required" } }],
      [["COL"], { code: "invalid_input", details: { argument: "column-name" } }],
      [["COL", "Review", "extra"], { code: "invalid_input" }],
      [["COL", "Review", "--yes", "--yes"], { code: "invalid_input", details: { argument: "--yes" } }],
      [["COL", "Review", "--unknown"], { code: "invalid_input" }],
      [["COL", " ", "--yes"], { code: "invalid_input", details: { field: ["columnName"] } }],
      [["COL", "Missing", "--yes"], { code: "not_found", details: { entity: "column", key: "Missing" } }],
      [["MISSING", "Review", "--yes"], { code: "not_found", details: { entity: "project", key: "MISSING" } }],
    ] as const) {
      const result = await runZinn(["project", "column", "delete", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
      expect(read()).toEqual(before);
    }
    const deleted = await runZinn(["project", "column", "delete", "col", " review ", "--yes", "--json"], dir);
    expect(deleted.code).toBe(0);
    expect(deleted.stderr).toBe("");
    expect(JSON.parse(deleted.stdout)).toEqual({
      id: expect.any(String), project_id: expect.any(String), project: "COL", name: "Review",
      is_first: false, is_last: false, category: "review",
    });
    expect(read().columns).toHaveLength(before.columns.length - 1);
    expect(read().activity).toHaveLength(before.activity.length + 1);
    const text = await runZinn(["project", "column", "delete", "COL", "Done", "--yes"], dir);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("Deleted");
    expect(text.stdout).toContain("COL");
    expect(text.stdout).toContain("Done");
  });
});

test("project column delete reports both task counts and commands to clear the column", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL"], dir);
    await runZinn(["task", "create", "COL", "--title", "Keep"], dir);
    for (const archived of [false, true]) {
      if (archived) {
        await runZinn(["task", "archive", "COL-1"], dir);
      }
      const result = await runZinn(["project", "column", "delete", "COL", "Backlog", "--yes", "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const error = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(error).toMatchObject({ code: "conflict", details: { entity: "column", reason: "has_tasks" } });
      expect(error.message).toContain(`${archived ? 0 : 1} active`);
      expect(error.message).toContain(`${archived ? 1 : 0} archived`);
      expect(error.message).toContain("zinn task move");
      expect(error.message).toContain("zinn task delete");
    }
  });
});

test("projects with no columns support reads, maintenance, recovery and deletion", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL"], dir);
    const columns = JSON.parse((await runZinn(["project", "column", "list", "COL", "--json"], dir)).stdout);
    for (const { name } of columns) {
      expect((await runZinn(["project", "column", "delete", "COL", name, "--yes"], dir)).code).toBe(0);
    }
    for (const args of [
      ["project", "list"], ["project", "view", "COL"], ["project", "column", "list", "COL"],
      ["task", "list", "COL"], ["task", "search", "anything", "COL"], ["backup"], ["reindex"],
    ]) {
      const result = await runZinn([...args, "--json"], dir);
      expect(result.code, result.stderr).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      if (args[0] === "task" || args.includes("column")) {
        expect(JSON.parse(result.stdout)).toEqual([]);
      }
    }
    const viewed = await runZinn(["project", "view", "COL"], dir);
    expect(viewed.code).toBe(0);
    expect(viewed.stdout).toContain("COL");
    expect(viewed.stdout).not.toContain("Columns:");
    const failed = await runZinn(["task", "create", "COL", "--title", "Refused", "--json"], dir);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    const error = errorDocumentSchema.parse(JSON.parse(failed.stderr)).error;
    expect(error.details).toMatchObject({ reason: "no_columns", key: "COL" });
    expect(error.message).toContain("zinn project column create COL <name>");
    expect(error.message).toContain("--category");
    expect((await runZinn(["project", "column", "create", "--category", "todo", "COL", "Recovered"], dir)).code).toBe(0);
    const created = await runZinn(["task", "create", "COL", "--title", "Recovered", "--json"], dir);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ key: "COL-1", column: "Recovered" });
    await runZinn(["task", "delete", "COL-1", "--yes"], dir);
    await runZinn(["project", "column", "delete", "COL", "Recovered", "--yes"], dir);
    expect((await runZinn(["project", "delete", "COL", "--yes"], dir)).code).toBe(0);
  });
});

test("column colors follow the category through renames, reorders and category changes, and column lists and task rows agree", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    const colored = (...args: Array<string>) => runZinn(args, dir, { FORCE_COLOR: "1" });
    const GRAY = "\x1b[90m";
    const BLUE = "\x1b[34m";
    const YELLOW = "\x1b[33m";
    const GREEN = "\x1b[32m";
    const colorCodes = [GRAY, BLUE, YELLOW, GREEN];

    await run("project", "create", "CAT");
    await run("task", "create", "CAT", "--title", "Triaged task");
    await run("task", "create", "CAT", "--title", "Shipped task");
    await run("task", "create", "CAT", "--title", "Verified task");
    // A renamed column keeps its color, and so does a column moved to the front of the board.
    await run("project", "column", "edit", "CAT", "Backlog", "--name", "Triaged");
    await run("project", "column", "edit", "CAT", "Done", "--name", "Shipped");
    await run("project", "column", "order", "CAT", "Shipped", "first");
    await run("project", "column", "create", "--category", "todo", "CAT", "Verified");
    await run("task", "move", "CAT-2", "Shipped");
    await run("task", "move", "CAT-3", "Verified");

    const columnList = (await colored("project", "column", "list", "CAT")).stdout;
    const taskRows = (await colored("task", "list", "CAT", "--state", "all")).stdout;
    for (const output of [columnList, taskRows]) {
      expect(output).toContain(`${GRAY}Triaged`);
      expect(output).toContain(`${GREEN}Shipped`);
      // A todo column is uncolored, even as the board's last column.
      for (const colorCode of colorCodes) {
        expect(output).not.toContain(`${colorCode}Verified`);
      }
    }
    expect(columnList).toContain(`${BLUE}Doing`);
    expect(columnList).toContain(`${YELLOW}Review`);
    expect(columnList).toContain(`${GRAY}Cancelled`);

    // Changing a category changes the color.
    expect((await run("project", "column", "edit", "CAT", "Verified", "--category", "review", "--yes")).code).toBe(0);
    for (const output of [
      (await colored("project", "column", "list", "CAT")).stdout,
      (await colored("task", "list", "CAT", "--state", "all")).stdout,
      (await colored("task", "view", "CAT-3")).stdout,
      (await colored("task", "blame", "CAT-3")).stdout,
    ]) {
      expect(output).toContain(`${YELLOW}Verified`);
    }
  });
});

test("project column create takes a name that begins with a dash only after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const readNames = () => withTestDb(dir, (db) =>
      db.query<{ name: string }, []>("SELECT name FROM project_column ORDER BY column_order").all().map(({ name }) => name),
    );
    const before = readNames();

    // ? A flag, a word that begins with a dash and the second half of an unquoted name are never saved as a name.
    for (const args of [["SHOP", "--name", "Waiting"], ["SHOP", "Needs", "Review"], ["SHOP", "-later"]]) {
      const result = await runZinn(["project", "column", "create", "--category", "todo", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readNames()).toEqual(before);
    }

    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "--", "-later"], dir)).code).toBe(0);
    expect(readNames()).toEqual([...before, "-later"]);
  });
});

test("project column create rejects a duplicate name regardless of casing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], testDir);
    expect((await runZinn(["project", "column", "create", "--category", "todo", "COL", "Later"], testDir)).code).toBe(0);
    const read = () => withTestDb(testDir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();

    const duplicate = await runZinn(["--json", "project", "column", "create", "--category", "todo", "COL", "later"], testDir);

    expect(duplicate.code).toBe(1);
    expect(duplicate.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(duplicate.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "column", key: "later" } });
    expect(read()).toEqual(before);
  });
});

test("project column create trims names and rejects invalid ones without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    const invalid = await runZinn(["project", "column", "create", "--category", "todo", "COL", "   ", "--json"], dir);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({
      code: "invalid_input", details: { field: ["name"] },
    });
    expect(read()).toEqual(before);

    const created = await runZinn(["project", "column", "create", "--category", "todo", "COL", " Later ", "--json"], dir);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "Later", is_first: false, is_last: true, category: "todo" });
  });
});

test("project column names are unique only within a project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    await runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);

    const alpha = await runZinn(["project", "column", "create", "--category", "todo", "ALPHA", "QA"], testDir, { FORCE_COLOR: "1" });
    const beta = await runZinn(["project", "column", "create", "--category", "todo", "BETA", "qa", "--json"], testDir);

    expect(alpha.code).toBe(0);
    expect(alpha.stderr).toBe("");
    expect(alpha.stdout).toContain("ALPHA");
    expect(alpha.stdout).toContain("QA");
    expect(beta.code).toBe(0);
    expect(JSON.parse(beta.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "BETA", name: "qa", is_first: false, is_last: true, category: "todo" });
  });
});

test("project column list returns columns in board order with active task counts and raw JSON under color", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "VIEW"], dir);
    await runZinn(["task", "create", "VIEW", "--title", "Visible task"], dir);
    await runZinn(["task", "create", "VIEW", "--title", "Review task"], dir);
    await runZinn(["task", "move", "VIEW-2", "Review"], dir);
    await runZinn(["project", "column", "order", "VIEW", "Review", "first"], dir);

    const json = await runZinn(["project", "column", "list", "view", "--json"], dir, { FORCE_COLOR: "1" });
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual([
      { id: expect.any(String), name: "Review", is_first: true, is_last: false, category: "review", taskCount: 1 },
      { id: expect.any(String), name: "Backlog", is_first: false, is_last: false, category: "backlog", taskCount: 1 },
      { id: expect.any(String), name: "TODO", is_first: false, is_last: false, category: "todo", taskCount: 0 },
      { id: expect.any(String), name: "Doing", is_first: false, is_last: false, category: "in_progress", taskCount: 0 },
      { id: expect.any(String), name: "Done", is_first: false, is_last: false, category: "done", taskCount: 0 },
      { id: expect.any(String), name: "Cancelled", is_first: false, is_last: true, category: "cancelled", taskCount: 0 },
    ]);
    await runZinn(["task", "archive", "VIEW-1"], dir);
    expect(JSON.parse((await runZinn(["project", "column", "list", "VIEW", "--json"], dir)).stdout)).toEqual([
      { id: expect.any(String), name: "Review", is_first: true, is_last: false, category: "review", taskCount: 1 },
      { id: expect.any(String), name: "Backlog", is_first: false, is_last: false, category: "backlog", taskCount: 0 },
      { id: expect.any(String), name: "TODO", is_first: false, is_last: false, category: "todo", taskCount: 0 },
      { id: expect.any(String), name: "Doing", is_first: false, is_last: false, category: "in_progress", taskCount: 0 },
      { id: expect.any(String), name: "Done", is_first: false, is_last: false, category: "done", taskCount: 0 },
      { id: expect.any(String), name: "Cancelled", is_first: false, is_last: true, category: "cancelled", taskCount: 0 },
    ]);

    const text = await runZinn(["project", "column", "list", "VIEW"], dir);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    for (const { name } of JSON.parse(json.stdout)) {
      expect(text.stdout).toContain(name);
    }
    expect(text.stdout).not.toContain("Archived");
  });
});

test("project column edit renames a column in place and keeps its tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    await runZinn(["task", "create", "COL", "--title", "Stays put"], dir);
    await runZinn(["task", "move", "COL-1", "todo"], dir);
    const readColumns = () =>
      withTestDb(dir, (db) => db.query("SELECT * FROM project_column ORDER BY column_order").all());
    const before = readColumns();

    const renamed = await runZinn(["project", "column", "edit", "col", "todo", "--name", " Next up "], dir, { FORCE_COLOR: "1" });
    expect(renamed.code).toBe(0);
    expect(renamed.stderr).toBe("");
    expect(renamed.stdout).toContain("COL");
    expect(renamed.stdout).toContain("Next up");
    expect(JSON.parse((await runZinn(["project", "column", "list", "COL", "--json"], dir)).stdout))
      .toContainEqual({ id: expect.any(String), name: "Next up", is_first: false, is_last: false, category: "todo", taskCount: 1 });
    expect(readColumns()).toEqual(
      before.map((row: any) => (row.name === "TODO" ? { ...row, name: "Next up" } : row)),
    );
    expect((await runZinn(["task", "view", "COL-1", "--json"], dir)).stdout).toContain(`"column": "Next up"`);

    const caseOnly = await runZinn(["project", "column", "edit", "COL", "next up", "--name", "NEXT UP", "--json"], dir);
    expect(JSON.parse(caseOnly.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "NEXT UP", is_first: false, is_last: false, category: "todo", changed: true });
    const dashName = await runZinn(["project", "column", "edit", "COL", "--name=--example", "NEXT UP", "--json"], dir);
    expect(dashName.code).toBe(0);
    expect(JSON.parse(dashName.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "--example", is_first: false, is_last: false, category: "todo", changed: true });
  });
});

test("project column edit rejects invalid requests without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    const usage = "Usage: zinn project column edit";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "project-key" }, help: expect.stringContaining(usage) }],
      [["COL"], { code: "invalid_input", details: { argument: "column-name" }, help: expect.stringContaining(usage) }],
      [["COL", "TODO", "extra", "--name", "Next"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["COL", "TODO"], { code: "invalid_input", message: expect.stringContaining("--name") }],
      [["COL", "TODO", "--name"], { code: "invalid_input", details: { argument: "--name" } }],
      [["COL", "TODO", "--title", "Next"], { code: "invalid_input", details: { argument: "--title" } }],
      [["COL", "TODO", "--name", "One", "--name", "Two"], { code: "invalid_input", details: { argument: "--name" } }],
      [["COL", "TODO", "--name", "   "], { code: "invalid_input", details: { field: ["name"] } }],
      [["COL", "TODO", "--name", "done"], { code: "conflict", details: { reason: "already_exists", entity: "column", key: "done" } }],
      [["COL", "Missing", "--name", "Next"], { code: "not_found", details: { entity: "column", key: "Missing" } }],
      [["NOPE", "TODO", "--name", "Next"], { code: "not_found", details: { entity: "project", key: "NOPE" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["project", "column", "edit", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
      expect(read()).toEqual(before);
    }

    const unchanged = await runZinn(["project", "column", "edit", "COL", "todo", "--name", "TODO"], dir);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stderr).toContain("TODO");
    expect(unchanged.stdout).toContain("COL");
    expect(unchanged.stdout).toContain("TODO");
    expect(read()).toEqual(before);
  });
});

test("project column order moves a column in every direction and prints it", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    // Five columns keep the expected orders short.
    await runZinn(["project", "column", "delete", "COL", "Cancelled", "--yes"], dir);
    const listColumns = async () => JSON.parse(
      (await runZinn(["project", "column", "list", "COL", "--json"], dir)).stdout,
    ).map((column: { name: string }) => column.name);

    const ordered = await runZinn(["project", "column", "order", "col", "review", "first"], dir, { FORCE_COLOR: "1" });
    expect(ordered.code).toBe(0);
    expect(ordered.stderr).toBe("");
    expect(ordered.stdout).toContain("COL");
    expect(ordered.stdout).toContain("Review");
    expect(await listColumns()).toEqual(["Review", "Backlog", "TODO", "Doing", "Done"]);

    const steps: Array<[string[], string[]]> = [
      [["Review", "next"], ["Backlog", "Review", "TODO", "Doing", "Done"]],
      [["Review", "last"], ["Backlog", "TODO", "Doing", "Done", "Review"]],
      [["Review", "previous"], ["Backlog", "TODO", "Doing", "Review", "Done"]],
      [["todo", "after", "DONE"], ["Backlog", "Doing", "Review", "Done", "TODO"]],
      [["todo", "before", "doing"], ["Backlog", "TODO", "Doing", "Review", "Done"]],
    ];
    for (const [args, expected] of steps) {
      const result = await runZinn(["project", "column", "order", "COL", ...args], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(await listColumns()).toEqual(expected);
    }

    const json = await runZinn(["project", "column", "order", "COL", "done", "first", "--json"], dir);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "Done", is_first: true, is_last: false, category: "done", changed: true });
  });
});

test("project column order rejects invalid requests and skips no-ops without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    await runZinn(["project", "column", "delete", "COL", "Cancelled", "--yes"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    const usage = "Usage: zinn project column order";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "project-key" }, help: expect.stringContaining(usage) }],
      [["COL"], { code: "invalid_input", details: { argument: "column-name" }, help: expect.stringContaining(usage) }],
      [["COL", "TODO"], { code: "invalid_input", details: { argument: "{first|previous|next|last|before|after}" }, help: expect.stringContaining(usage) }],
      [["COL", "TODO", "sideways"], { code: "invalid_input", message: expect.stringContaining("sideways"), details: { argument: "direction" } }],
      [["COL", "TODO", "top"], { code: "invalid_input", message: expect.stringContaining("top"), details: { argument: "direction" } }],
      [["COL", "TODO", "before"], { code: "invalid_input", details: { argument: "target-column-name" }, help: expect.stringContaining(usage) }],
      [["COL", "TODO", "before", "Done", "Review"], { code: "invalid_input", message: expect.stringContaining("Review"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["COL", "TODO", "first", "Done"], { code: "invalid_input", message: expect.stringContaining("Done"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["COL", "   ", "first"], { code: "invalid_input", details: { field: ["columnName"] } }],
      [["COL", "Missing", "first"], { code: "not_found", details: { entity: "column", key: "Missing" } }],
      [["COL", "TODO", "after", "Missing"], { code: "not_found", details: { entity: "column", key: "Missing" } }],
      [["NOPE", "TODO", "first"], { code: "not_found", details: { entity: "project", key: "NOPE" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["project", "column", "order", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
      expect(read()).toEqual(before);
    }

    for (const json of [false, true]) {
      for (const [name, ...placement] of [
        ["Backlog", "first"], ["Backlog", "previous"], ["Done", "last"], ["Done", "next"],
        ["TODO", "before", "Doing"], ["TODO", "after", "Backlog"],
        ["TODO", "before", "todo"], ["TODO", "after", "TODO"],
      ]) {
        const unchanged = await runZinn(["project", "column", "order", "col", name!, ...placement, ...(json ? ["--json"] : [])], dir);
        expect(unchanged.code).toBe(0);
        expect(unchanged.stderr).toContain(name!);
        expect(unchanged.stderr.trim().split("\n")).toHaveLength(1);
        if (json) {
          expect(JSON.parse(unchanged.stdout)).toMatchObject({ project: "COL", name, changed: false });
        } else {
          expect(unchanged.stdout).toContain("COL");
          expect(unchanged.stdout).toContain(name!);
        }
        expect(read()).toEqual(before);
      }
    }
  });
});

test("project column create requires a category, listing the valid values, and writes nothing without one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();

    for (const args of [["COL", "Shipped"], ["COL", "Shipped", "--category", "finished"], ["COL", "Shipped", "--category"]]) {
      const result = await runZinn(["project", "column", "create", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const error = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(error.code).toBe("invalid_input");
      if (args.length !== 3) {
        for (const category of ["backlog", "todo", "in_progress", "review", "done", "cancelled"]) {
          expect(error.message).toContain(category);
        }
      }
      expect(read()).toEqual(before);
    }

    const created = await runZinn(["project", "column", "create", "COL", "Shipped", "--category", "done", "--json"], dir);
    expect(JSON.parse(created.stdout)).toMatchObject({ name: "Shipped", category: "done" });
    const text = await runZinn(["project", "column", "list", "COL"], dir);
    expect(text.stdout).toContain("Shipped");
    expect(text.stdout).toContain("done");
  });
});

test("project column edit changes a category, asking first only when the column holds tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL"], dir);
    await runZinn(["task", "create", "COL", "--title", "Archived in Review", "--column", "Review"], dir);
    await runZinn(["task", "archive", "COL-1"], dir);
    const categoryOf = (name: string) => withTestDb(dir, (db) =>
      db.query<{ category: string }, [string]>("SELECT category FROM project_column WHERE name = ?").get(name)!.category);

    // An empty column changes without a prompt, and a rename keeps the category.
    const empty = await runZinn(["project", "column", "edit", "COL", "TODO", "--category", "backlog", "--json"], dir);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ name: "TODO", category: "backlog", changed: true });
    const renamed = await runZinn(["project", "column", "edit", "COL", "TODO", "--name", "Later", "--json"], dir);
    expect(JSON.parse(renamed.stdout)).toMatchObject({ name: "Later", category: "backlog", changed: true });

    // An archived task counts, so Review needs confirmation: --yes, as JSON or without a terminal.
    for (const args of [["--json"], []]) {
      const refused = await runZinn(["project", "column", "edit", "COL", "Review", "--category", "done", ...args], dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--yes");
      expect(categoryOf("Review")).toBe("review");
    }
    const confirmed = await runZinn(["project", "column", "edit", "COL", "Review", "--category", "done", "--yes", "--json"], dir);
    expect(confirmed.code).toBe(0);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ name: "Review", category: "done", changed: true });
    expect(categoryOf("Review")).toBe("done");

    // The same category is a no-op and asks nothing.
    const unchanged = await runZinn(["project", "column", "edit", "COL", "Review", "--category", "done", "--json"], dir);
    expect(unchanged.code).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ category: "done", changed: false });
  });
});
