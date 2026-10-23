import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("project column create takes a name that begins with a dash only after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const readNames = () => withTestDb(dir, (db) =>
      db.query<{ name: string }, []>("SELECT name FROM project_column ORDER BY column_order").all().map(({ name }) => name),
    );
    const before = readNames();

    // ? A flag, a word that begins with a dash and the second half of an unquoted name are never saved as a name.
    for (const args of [["SHOP", "--name", "Waiting"], ["SHOP", "Needs", "Review"], ["SHOP", "-later"]]) {
      const result = await runZinn(["project", "column", "create", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readNames()).toEqual(before);
    }

    expect((await runZinn(["project", "column", "create", "SHOP", "--", "-later"], dir)).code).toBe(0);
    expect(readNames()).toEqual([...before, "-later"]);
  });
});

test("project column create rejects a duplicate name regardless of casing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], testDir);
    expect((await runZinn(["project", "column", "create", "COL", "Later"], testDir)).code).toBe(0);
    const read = () => withTestDb(testDir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();

    const duplicate = await runZinn(["--json", "project", "column", "create", "COL", "later"], testDir);

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
    const invalid = await runZinn(["project", "column", "create", "COL", "   ", "--json"], dir);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({
      code: "invalid_input", details: { field: ["name"] },
    });
    expect(read()).toEqual(before);

    const created = await runZinn(["project", "column", "create", "COL", " Later ", "--json"], dir);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "Later" });
  });
});

test("project column names are unique only within a project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    await runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);

    const alpha = await runZinn(["project", "column", "create", "ALPHA", "QA"], testDir, { FORCE_COLOR: "1" });
    const beta = await runZinn(["project", "column", "create", "BETA", "qa", "--json"], testDir);

    expect(alpha.code).toBe(0);
    expect(alpha.stderr).toBe("");
    expect(alpha.stdout).toContain("ALPHA");
    expect(alpha.stdout).toContain("QA");
    expect(beta.code).toBe(0);
    expect(JSON.parse(beta.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "BETA", name: "qa" });
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
      { id: expect.any(String), name: "Review", taskCount: 1 },
      { id: expect.any(String), name: "Backlog", taskCount: 1 },
      { id: expect.any(String), name: "TODO", taskCount: 0 },
      { id: expect.any(String), name: "In Progress", taskCount: 0 },
      { id: expect.any(String), name: "Done", taskCount: 0 },
    ]);
    await runZinn(["task", "archive", "VIEW-1"], dir);
    expect(JSON.parse((await runZinn(["project", "column", "list", "VIEW", "--json"], dir)).stdout)).toEqual([
      { id: expect.any(String), name: "Review", taskCount: 1 },
      { id: expect.any(String), name: "Backlog", taskCount: 0 },
      { id: expect.any(String), name: "TODO", taskCount: 0 },
      { id: expect.any(String), name: "In Progress", taskCount: 0 },
      { id: expect.any(String), name: "Done", taskCount: 0 },
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
      .toContainEqual({ id: expect.any(String), name: "Next up", taskCount: 1 });
    expect(readColumns()).toEqual(
      before.map((row: any) => (row.name === "TODO" ? { ...row, name: "Next up" } : row)),
    );
    expect((await runZinn(["task", "view", "COL-1", "--json"], dir)).stdout).toContain(`"column": "Next up"`);

    const caseOnly = await runZinn(["project", "column", "edit", "COL", "next up", "--name", "NEXT UP", "--json"], dir);
    expect(JSON.parse(caseOnly.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "NEXT UP" });
    const dashName = await runZinn(["project", "column", "edit", "COL", "--name=--example", "NEXT UP", "--json"], dir);
    expect(dashName.code).toBe(0);
    expect(JSON.parse(dashName.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "--example" });
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
    expect(unchanged.stderr).toBe("");
    expect(unchanged.stdout).toContain("COL");
    expect(unchanged.stdout).toContain("TODO");
    expect(read()).toEqual(before);
  });
});

test("project column order moves a column in every direction and prints it", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const listColumns = async () => JSON.parse(
      (await runZinn(["project", "column", "list", "COL", "--json"], dir)).stdout,
    ).map((column: { name: string }) => column.name);

    const ordered = await runZinn(["project", "column", "order", "col", "review", "first"], dir, { FORCE_COLOR: "1" });
    expect(ordered.code).toBe(0);
    expect(ordered.stderr).toBe("");
    expect(ordered.stdout).toContain("COL");
    expect(ordered.stdout).toContain("Review");
    expect(await listColumns()).toEqual(["Review", "Backlog", "TODO", "In Progress", "Done"]);

    const steps: Array<[string[], string[]]> = [
      [["Review", "next"], ["Backlog", "Review", "TODO", "In Progress", "Done"]],
      [["Review", "last"], ["Backlog", "TODO", "In Progress", "Done", "Review"]],
      [["Review", "previous"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
      [["todo", "after", "DONE"], ["Backlog", "In Progress", "Review", "Done", "TODO"]],
      [["todo", "before", "in progress"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
    ];
    for (const [args, expected] of steps) {
      expect((await runZinn(["project", "column", "order", "COL", ...args], dir)).code).toBe(0);
      expect(await listColumns()).toEqual(expected);
    }

    const json = await runZinn(["project", "column", "order", "COL", "done", "first", "--json"], dir);
    expect(JSON.parse(json.stdout)).toEqual({ id: expect.any(String), project_id: expect.any(String), project: "COL", name: "Done" });
  });
});

test("project column order rejects invalid requests and skips no-ops without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "COL", "--name", "Columns"], dir);
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

    const unchanged = await runZinn(["project", "column", "order", "COL", "backlog", "first"], dir);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stderr).toBe("");
    expect(unchanged.stdout).toContain("Backlog");
    expect(read()).toEqual(before);
  });
});
