import { expect, test } from "bun:test";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { runCliInTerminal } from "../testing";
import { createEmptyDatabase, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("project create seeds the default columns", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "WIP", "--name", "Work"], testDir)).code).toBe(0);

    const listed = await runZinn(["project", "column", "list", "WIP", "--json"], testDir);

    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      { id: expect.any(String), name: "Backlog", is_first: true, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "TODO", is_first: false, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "In Progress", is_first: false, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "Review", is_first: false, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "Done", is_first: false, is_last: true, taskCount: 0 },
    ]);
  });
});

test("project create requires a key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["project", "create"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: zinn project create");
  });
});

test("project create defaults the stored name to the uppercase key and allows a later rename", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const created = await runZinn(["project", "create", "site"], testDir);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("SITE | SITE\n");
    withTestDb(testDir, (db) => {
      expect(db.query("SELECT key, name FROM project").get()).toEqual({
        key: "SITE",
        name: "SITE",
      });
    });

    const edited = await runZinn(["project", "edit", "SITE", "--name", "Website refresh"], testDir);
    expect(edited.code).toBe(0);
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("SITE | Website refresh | 0 active | 0 archived\n");
  });
});

test("project create rejects extra positionals and invalid name flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const args of [
      ["SITE", "Website"],
      ["SITE", "--name"],
      ["SITE", "--name", "First", "--name", "Second"],
      ["SITE", "--title", "Website"],
    ]) {
      expect((await runZinn(["project", "create", ...args], testDir)).code).toBe(1);
    }
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("");
  });
});

test("project create rejects a duplicate key regardless of casing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "DUP", "--name", "First"], testDir)).code).toBe(0);

    const second = await runZinn(["--json", "project", "create", "dup", "--name", "Second"], testDir);

    expect(second.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(second.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "project", key: "DUP" } });
  });
});

test("project delete accepts a non-standardized key and removes its columns and tasks", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "GONE", "--name", "Doomed"], testDir);
    await runZinn(["task", "create", "GONE", "--title", "Doomed task"], testDir);
    await runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    expect(
      (await runZinn(["project", "delete", "gone", "--yes"], testDir)).code,
    ).toBe(0);

    withTestDb(testDir, (db) => {
      expect(db.query("SELECT * FROM project WHERE key = 'GONE'").get()).toBeNull();
      expect(
        db
          .query("SELECT * FROM project_column WHERE project_id NOT IN (SELECT id FROM project)")
          .all(),
      ).toEqual([]);
      expect(
        db.query("SELECT * FROM task WHERE project_id NOT IN (SELECT id FROM project)").all(),
      ).toEqual([]);
      expect(db.query("SELECT * FROM project WHERE key = 'KEEP'").get()).not.toBeNull();
      expect(db.query("SELECT * FROM task WHERE title = 'Kept task'").get()).not.toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

test.serial("project delete keeps the project when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    const result = await runCliInTerminal(["project", "delete", "keep"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("KEEP | Kept");
    expect((await runZinn(["project", "list"], testDir)).stdout).toContain("KEEP | Kept");
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).toContain("Kept task");
  });
});

test("project delete rejects an unknown key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const result = await runZinn(["--json", "project", "delete", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOSUCH" } });
  });
});

test("project list on an empty database exits cleanly without inventing a row", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("project list renders every project once and aligns unequal key widths", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "a", "--name", "Short"], testDir)).code).toBe(0);
    expect((await runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir)).code).toBe(0);

    const result = await runZinn(["project", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    const rows = lines.map((line) => line.split("|").map((cell) => cell.trim()));
    expect(rows).toContainEqual(["A", "Short", "0 active", "0 archived"]);
    expect(rows).toContainEqual(["LONGKEY", "Long", "0 active", "0 archived"]);
    expect(lines[0]!.indexOf("|")).toBe(lines[1]!.indexOf("|"));
  });
});

test("project list reports active and archived counts in text and its JSON contract", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result;
    };
    const app = JSON.parse((await run("project", "create", "APP", "--name", "Application", "--description", "Full\ndescription", "--json")).stdout);
    const empty = JSON.parse((await run("project", "create", "EMPTY", "--json")).stdout);
    const old = JSON.parse((await run("project", "create", "OLD", "--json")).stdout);
    for (const title of ["Backlog", "Done", "Archived"]) {
      await run("task", "create", "APP", "--title", title);
    }
    await run("task", "create", "OLD", "--title", "Old task");
    await run("task", "move", "APP-2", "Done");
    await run("task", "archive", "APP-3", "OLD-1");

    const listed = JSON.parse((await run("project", "list", "--json")).stdout);
    expect(listed).toEqual([
      { ...app, taskCounts: { active: 2, archived: 1 } },
      { ...empty, taskCounts: { active: 0, archived: 0 } },
      { ...old, taskCounts: { active: 0, archived: 1 } },
    ]);
    const text = await run("project", "list");
    expect(text.stdout.trimEnd().split("\n").map((line) => line.split("|").map((cell) => cell.trim()))).toEqual([
      ["APP", "Application", "2 active", "1 archived", "Full description"],
      ["EMPTY", "EMPTY", "0 active", "0 archived"],
      ["OLD", "OLD", "0 active", "1 archived"],
    ]);

    const viewed = JSON.parse((await run("project", "view", "APP", "--json")).stdout);
    expect(viewed.columns.reduce((sum: number, entry: { taskCount: number }) => sum + entry.taskCount, 0)).toBe(listed[0].taskCounts.active);
    expect(viewed.archivedTaskCount).toBe(listed[0].taskCounts.archived);
    expect(viewed).not.toHaveProperty("taskCounts");
    expect(JSON.parse((await run("project", "edit", "APP", "--name", "Edited", "--json")).stdout)).toEqual({
      ...app, name: "Edited", changed: true,
    });
    await run("task", "unarchive", "APP-3");
    await run("task", "delete", "APP-1", "--yes");
    expect(JSON.parse((await run("project", "list", "--json")).stdout)[0].taskCounts).toEqual({ active: 2, archived: 0 });
  });
});

test("project list does not retain a deleted project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["project", "create", "REMOVE", "--name", "Remove"], testDir);
    expect(
      (await runZinn(["project", "delete", "REMOVE", "--yes"], testDir)).code,
    ).toBe(0);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KEEP");
    expect(result.stdout).not.toContain("REMOVE");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project view prints the full description and unarchived task counts per column, with archived tasks as one total", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const description = "Refine the numbers\n  Keep the quota";
    await run("project", "create", "VIEW", "--name", "Project view", "--description", description);
    await run("project", "create", "OTHER");
    await run("task", "create", "OTHER", "--title", "Elsewhere");
    for (const title of ["Backlog task", "First done", "Second done", "Archived task"]) {
      await run("task", "create", "VIEW", "--title", title, "--description", "Task description");
    }
    await run("task", "move", "VIEW-2", "VIEW-3", "Done");
    await run("task", "archive", "VIEW-4");

    const viewedProject = await run("project", "view", "view");

    expect(viewedProject.code).toBe(0);
    expect(viewedProject.stderr).toBe("");
    expect(viewedProject.stdout).toBe(
      [
        "VIEW | Project view",
        "",
        "Description:",
        "Refine the numbers",
        "  Keep the quota",
        "",
        "Columns:",
        "Backlog     | 1",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 2",
        "Archived    | 1",
        "",
      ].join("\n"),
    );
  });
});

test("project view leaves out the Description section and Archived row when there is nothing to show", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty project"], testDir);

    expect((await runZinn(["project", "view", "EMPTY"], testDir)).stdout).toBe(
      [
        "EMPTY | Empty project",
        "",
        "Columns:",
        "Backlog     | 0",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 0",
        "",
      ].join("\n"),
    );
  });
});

test("project view JSON contains the project, per-column task counts in board order and the archived total", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "VIEW", "--name", "Project view", "--description", "Full\ndescription");
    await run("task", "create", "VIEW", "--title", "Visible task");
    await run("task", "create", "VIEW", "--title", "Review task");
    await run("task", "move", "VIEW-2", "Review");
    await run("project", "column", "order", "VIEW", "Review", "first");

    const expectedColumns = [
      { id: expect.any(String), name: "Review", is_first: true, is_last: false, taskCount: 1 },
      { id: expect.any(String), name: "Backlog", is_first: false, is_last: false, taskCount: 1 },
      { id: expect.any(String), name: "TODO", is_first: false, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "In Progress", is_first: false, is_last: false, taskCount: 0 },
      { id: expect.any(String), name: "Done", is_first: false, is_last: true, taskCount: 0 },
    ];
    const viewedProject = await run("project", "view", "VIEW", "--json");

    expect(viewedProject.code).toBe(0);
    expect(JSON.parse(viewedProject.stdout)).toEqual({
      id: expect.any(String),
      key: "VIEW",
      name: "Project view",
      description: "Full\ndescription",
      columns: expectedColumns,
      archivedTaskCount: 0,
    });

    await run("task", "archive", "VIEW-1");
    expect(JSON.parse((await run("project", "view", "VIEW", "--json")).stdout)).toMatchObject({
      columns: [expectedColumns[0], { name: "Backlog", taskCount: 0 }, ...expectedColumns.slice(2)],
      archivedTaskCount: 1,
    });
  });
});

test("project view validates its project key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const missing = await runZinn(["project", "view"], testDir);
    const extra = await runZinn(["project", "view", "ONE", "TWO"], testDir);
    const unknown = await runZinn(["--json", "project", "view", "unknown"], testDir);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Usage: zinn project view");
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain(`"TWO"`);
    expect(extra.stderr).toContain("Usage: zinn project view");
    expect(unknown.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unknown.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "UNKNOWN" } });
  });
});

test("project create accepts an alphanumeric key in any casing and stores it uppercase", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "b2B", "--name", "Business"], testDir)).code).toBe(0);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("B2B | Business | 0 active | 0 archived\n");
  });
});

test("project create rejects keys outside the alphanumeric contract", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const invalidKey of ["2B", "APP-DEV", "APP_DEV", "ÅPP", ""]) {
      const result = await runZinn(["--json", "project", "create", invalidKey, "--name", "Invalid"], testDir);

      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["key"] } });
    }
  });
});

test("project create rejects blank or non-single-line names", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const invalidName of ["", "   ", "first line\nsecond line", "name\u001b[31m"]) {
      const result = await runZinn(["--json", "project", "create", "SAFE", "--name", invalidName], testDir);

      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["name"] } });
    }
  });
});

test("project edit renames without changing identity, tasks, columns, or archive state", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Keep task"], dir);
    const read = () => withTestDb(dir, (db) => ({
      project: db.query<import("../../core/src/types").Project, []>("SELECT * FROM project").get()!,
      tasks: db.query("SELECT * FROM task").all(),
      columns: db.query("SELECT * FROM project_column").all(),
    }));
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1, archived_at = 2"));
    const before = read();
    const result = await runZinn(["project", "edit", "edit", "--name", "New name"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("EDIT | New name\n");
    expect(result.stderr).toBe("");
    const after = read();
    expect(after).toEqual({ ...before, project: {
      ...before.project, name: "New name", updated_at: after.project.updated_at,
    } });
    expect(after.project.updated_at).toBeGreaterThan(1);
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1"));
    expect((await runZinn(["project", "edit", "EDIT", "--name", "New name"], dir)).code).toBe(0);
    expect(read().project.updated_at).toBe(1);
    expect((await runZinn(["project", "edit", "--name=--example", "EDIT"], dir)).code).toBe(0);
    expect((await runZinn(["project", "list"], dir)).stdout).toContain("EDIT | --example");
  });
});

test("project edit rejects invalid requests without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project").get());
    const before = read();
    const usage = "Usage: zinn project edit";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "project-key" }, help: expect.stringContaining(usage) }],
      [["EDIT"], { code: "invalid_input" }],
      [["EDIT", "--name"], { code: "invalid_input", details: { argument: "--name" } }],
      [["EDIT", "--key", "NEW"], { code: "invalid_input", details: { argument: "--key" } }],
      [["EDIT", "extra", "--name", "Name"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["EDIT", "--name", "One", "--name", "Two"], { code: "invalid_input", details: { argument: "--name" } }],
      [["EDIT", "--name", ""], { code: "invalid_input", details: { field: ["name"] } }],
      [["EDIT", "--name", "   "], { code: "invalid_input", details: { field: ["name"] } }],
      [["EDIT", "--name", "Two\nlines"], { code: "invalid_input", details: { field: ["name"] } }],
      [["MISSING", "--name", "Name"], { code: "not_found", details: { entity: "project", key: "MISSING" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["project", "edit", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
      expect(read()).toEqual(before);
    }
  });
});

test("project list shows every established project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "LIST", "--name", "Listed"], testDir);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LIST");
  });
});

test("project mutations print the affected entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["project", "create", "life", "--name", "Responsive"], testDir)).stdout).toBe(
      "LIFE | Responsive\n",
    );
    expect((await runZinn(["project", "delete", "life", "--yes"], testDir)).stdout).toContain(
      "Deleted LIFE | Responsive\n",
    );
  });
});

test("project descriptions flow through creation, partial edits, view, list and clearing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "Purpose\nMore context";
    const created = await run("project", "create", "DESC", "--description", description, "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "DESC", description });
    expect((await run("project", "view", "DESC")).stdout).toStartWith(`DESC | DESC\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "list")).stdout).toBe("DESC | DESC | 0 active | 0 archived | Purpose More context\n");
    expect(JSON.parse((await run("project", "list", "--json")).stdout)[0].description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--name", "Renamed", "--json")).stdout).description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--description", "Updated", "--json")).stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "Renamed", description: "Updated", changed: true });
    expect((await run("project", "edit", "DESC", "--description", "")).stdout).toBe("DESC | Renamed\n");
    expect(JSON.parse((await run("project", "view", "DESC", "--json")).stdout).description).toBeNull();
    expect((await run("project", "edit", "DESC", "--description", "a", "--description", "b")).code).toBe(1);
  });
});
