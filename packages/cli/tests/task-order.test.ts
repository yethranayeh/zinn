import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task order moves a task one position up or down within its column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "first task"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "second task"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "third task"], testDir);

    const movedUp = await runZinn(["task", "order", "ORDER-2", "up"], testDir);
    expect(movedUp.code).toBe(0);
    expect(movedUp.stderr).toBe("");
    expect((await runZinn(["task", "list", "ORDER"], testDir)).stdout).toMatch(
      /ORDER-2[^\n]*\nORDER-1[^\n]*\nORDER-3/,
    );

    const movedDown = await runZinn(["task", "order", "ORDER-2", "down"], testDir);
    expect(movedDown.code).toBe(0);
    expect(movedDown.stderr).toBe("");
    expect((await runZinn(["task", "list", "ORDER"], testDir)).stdout).toMatch(
      /ORDER-1[^\n]*\nORDER-2[^\n]*\nORDER-3/,
    );
  });
});

test("task order moves a task to the top or bottom of its column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EDGES", "--name", "Edges"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "first task"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "second task"], testDir);
    await runZinn(["task", "create", "EDGES", "--title", "third task"], testDir);

    expect((await runZinn(["task", "order", "EDGES-3", "top"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "EDGES"], testDir)).stdout).toMatch(
      /EDGES-3[^\n]*\nEDGES-1[^\n]*\nEDGES-2/,
    );

    expect((await runZinn(["task", "order", "EDGES-3", "bottom"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "EDGES"], testDir)).stdout).toMatch(
      /EDGES-1[^\n]*\nEDGES-2[^\n]*\nEDGES-3/,
    );
  });
});

test("task order places a task immediately before or after its target", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ANCHOR", "--name", "Anchored"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "first task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "second task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "third task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "fourth task"], testDir);
    await runZinn(["task", "create", "ANCHOR", "--title", "fifth task"], testDir);

    expect((await runZinn(["task", "order", "ANCHOR-4", "before", "ANCHOR-2"], testDir)).code).toBe(
      0,
    );
    expect((await runZinn(["task", "list", "ANCHOR"], testDir)).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-4[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-5/,
    );

    expect((await runZinn(["task", "order", "ANCHOR-4", "after", "ANCHOR-3"], testDir)).code).toBe(
      0,
    );
    expect((await runZinn(["task", "list", "ANCHOR"], testDir)).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-4[^\n]*\nANCHOR-5/,
    );
  });
});

test("task order requires a task key and an ordering instruction", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const missingTask = await runZinn(["task", "order"], testDir);
    expect(missingTask.code).toBe(1);
    expect(missingTask.stderr).toContain("Usage: zinn task order");

    const missingInstruction = await runZinn(["task", "order", "ORDER-1"], testDir);
    expect(missingInstruction.code).toBe(1);
    expect(missingInstruction.stderr).toContain("Usage: zinn task order");
  });
});

test("task order validates direction and target arguments", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const unknownDirection = await runZinn(["--json", "task", "order", "ORDER-1", "sideways"], testDir);
    expect(unknownDirection.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknownDirection.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "direction" } });

    const missingTarget = await runZinn(["task", "order", "ORDER-1", "before"], testDir);
    expect(missingTarget.code).toBe(1);
    expect(missingTarget.stderr).toContain("Usage: zinn task order");

    const unexpectedTarget = await runZinn(["task", "order", "ORDER-1", "top", "ORDER-2"], testDir);
    expect(unexpectedTarget.code).toBe(1);
    expect(unexpectedTarget.stderr).toContain('"ORDER-2"');
    expect(unexpectedTarget.stderr).toContain("Usage: zinn task order");
  });
});

test("task order help documents its own command", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["task", "order", "--help"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: zinn task order");
    expect(result.stdout).toContain("top");
    expect(result.stdout).toContain("up");
    expect(result.stdout).toContain("down");
    expect(result.stdout).toContain("bottom");
    expect(result.stdout).toContain("before");
    expect(result.stdout).toContain("after");
  });
});

test("task order does not cross a column boundary", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "BOUND", "--name", "Bounded"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "backlog first"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "backlog last"], testDir);
    await runZinn(["task", "create", "BOUND", "--title", "progress first"], testDir);
    await runZinn(["task", "move", "BOUND-3", "In Progress"], testDir);

    withTestDb(testDir, (db) => {
      db.run("UPDATE task SET updated_at = 1 WHERE number IN (2, 3)");
    });

    expect((await runZinn(["task", "order", "BOUND-2", "down"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "order", "BOUND-3", "up"], testDir)).code).toBe(0);

    const rows = withTestDb(testDir, (db) =>
      db
        .query<{ number: number; updated_at: number }, []>(
          "SELECT number, updated_at FROM task WHERE number IN (2, 3) ORDER BY number",
        )
        .all(),
    );

    expect(rows).toEqual([
      { number: 2, updated_at: 1 },
      { number: 3, updated_at: 1 },
    ]);
  });
});

test("task order rejects an unknown target task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "TARGET", "--name", "Targeted"], testDir);
    await runZinn(["task", "create", "TARGET", "--title", "existing task"], testDir);

    const result = await runZinn(["--json", "task", "order", "TARGET-1", "before", "TARGET-99"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "TARGET-99" } });
  });
});

test("task order rejects a target in another column", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SCOPE", "--name", "Scoped"], testDir);
    await runZinn(["task", "create", "SCOPE", "--title", "backlog task"], testDir);
    await runZinn(["task", "create", "SCOPE", "--title", "progress task"], testDir);
    await runZinn(["task", "move", "SCOPE-2", "In Progress"], testDir);

    const result = await runZinn(["--json", "task", "order", "SCOPE-1", "before", "SCOPE-2"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "different_column" } });
  });
});

test("task order targeting itself is a no-op", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "UNCHANGED", "--name", "Unchanged"], testDir);
    await runZinn(["task", "create", "UNCHANGED", "--title", "stationary task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));

    expect(
      (await runZinn(["task", "order", "UNCHANGED-1", "before", "UNCHANGED-1"], testDir)).code,
    ).toBe(0);

    const row = withTestDb(testDir, (db) =>
      db
        .query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1")
        .get(),
    );

    expect(row?.updated_at).toBe(1);
  });
});

test("task order leaves already-satisfied placements unchanged", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SATISFIED", "--name", "Satisfied"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "first task"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "second task"], testDir);
    await runZinn(["task", "create", "SATISFIED", "--title", "third task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1"));

    const read = () => withTestDb(testDir, (db) => ({
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    for (const json of [false, true]) {
      for (const [key, ...placement] of [
        ["SATISFIED-1", "top"], ["SATISFIED-1", "up"],
        ["SATISFIED-3", "bottom"], ["SATISFIED-3", "down"],
        ["SATISFIED-2", "before", "SATISFIED-3"], ["SATISFIED-2", "after", "SATISFIED-1"],
        ["SATISFIED-2", "before", "SATISFIED-2"], ["SATISFIED-2", "after", "SATISFIED-2"],
      ]) {
        const result = await runZinn(["task", "order", key!.toLowerCase(), ...placement, ...(json ? ["--json"] : [])], testDir);
        expect(result.code).toBe(0);
        expect(result.stderr).toContain(key!);
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ key, changed: false });
        } else {
          expect(result.stdout).toContain(key!);
        }
        expect(read()).toEqual(before);
      }
    }

    const timestamps = withTestDb(testDir, (db) =>
      db.query<{ updated_at: number }, []>("SELECT updated_at FROM task ORDER BY number").all(),
    );
    expect(timestamps).toEqual([{ updated_at: 1 }, { updated_at: 1 }, { updated_at: 1 }]);
  });
});

test("task order rejects a target in another project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "FIRST", "--name", "First"], testDir);
    await runZinn(["project", "create", "SECOND", "--name", "Second"], testDir);
    await runZinn(["task", "create", "FIRST", "--title", "first project task"], testDir);
    await runZinn(["task", "create", "SECOND", "--title", "second project task"], testDir);

    const result = await runZinn(["--json", "task", "order", "FIRST-1", "before", "SECOND-1"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "different_project" } });
  });
});

test("task order rejects archived source and target tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ARCHORDER", "--name", "Archived order"], testDir);
    await runZinn(["task", "create", "ARCHORDER", "--title", "active task"], testDir);
    await runZinn(["task", "create", "ARCHORDER", "--title", "archived task"], testDir);
    await runZinn(["task", "archive", "ARCHORDER-2"], testDir);

    const archivedSource = await runZinn(["--json", "task", "order", "ARCHORDER-2", "top"], testDir);
    expect(archivedSource.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archivedSource.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHORDER-2" } });

    const archivedTarget = await runZinn(["--json", "task", "order", "ARCHORDER-1", "before", "ARCHORDER-2"], testDir);
    expect(archivedTarget.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archivedTarget.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", key: "ARCHORDER-2" } });
  });
});

test("task order uses visible active neighbours", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "VISIBLE", "--name", "Visible"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "first task"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "archived task"], testDir);
    await runZinn(["task", "create", "VISIBLE", "--title", "third task"], testDir);
    await runZinn(["task", "archive", "VISIBLE-2"], testDir);

    expect((await runZinn(["task", "order", "VISIBLE-1", "down"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "VISIBLE"], testDir)).stdout).toMatch(
      /VISIBLE-3[^\n]*\nVISIBLE-1/,
    );
  });
});
