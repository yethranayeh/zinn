import { expect, test } from "bun:test";
import { join } from "node:path";

import { errorDocumentSchema } from "../src/errors";
import { createEmptyDatabase, runZinn, SECTION_RULE, taskViewContent, withIsolatedZinnDir } from "../test-helpers";

test("task list on an empty database exits cleanly without output", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const result = await runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list --column filters project and global results with labels and archive flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const keys = async (...args: Array<string>) => {
      const result = await run("task", "list", ...args, "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout).map((row: { key: string }) => row.key);
    };
    expect((await run("project", "create", "AAA")).code).toBe(0);
    expect((await run("project", "create", "BBB")).code).toBe(0);
    expect((await run("label", "create", "CLI")).code).toBe(0);
    expect((await run("label", "create", "Groom")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "Both", "--column", "Doing", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "CLI only", "--column", "Doing", "--label", "CLI")).code).toBe(0);
    expect((await run("task", "create", "AAA", "--title", "Elsewhere", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "create", "BBB", "--title", "Archived", "--column", "Doing", "--label", "CLI", "--label", "Groom")).code).toBe(0);
    expect((await run("task", "archive", "BBB-1")).code).toBe(0);

    expect(await keys("--column", "DOING")).toEqual(["AAA-1", "AAA-2"]);
    expect(await keys("AAA", "--column", "doing", "--label", "cli", "--label", "GROOM")).toEqual(["AAA-1"]);
    expect(await keys("--column", "Doing", "--archived", "--label", "CLI", "--label", "Groom")).toEqual(["BBB-1"]);
    expect(await keys("--column", "Doing", "--all", "--label", "CLI", "--label", "Groom")).toEqual(["AAA-1", "BBB-1"]);
    const unfiltered = JSON.parse((await run("task", "list", "--all", "--json")).stdout);
    const filtered = JSON.parse((await run("task", "list", "--column", "Doing", "--all", "--json")).stdout);
    expect(filtered).toEqual(unfiltered.filter((row: { column: string }) => row.column === "Doing"));
    const text = await run("task", "list", "AAA", "--column", "Doing");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("AAA-1");
    expect(text.stdout).toContain("AAA-2");
    expect(text.stdout).not.toContain("AAA-3");

    expect(await keys("AAA", "--column", "Nowhere")).toEqual([]);
    expect(await run("task", "list", "AAA", "--column", "Nowhere")).toEqual({ stdout: "", stderr: "", code: 0 });
    const repeated = await run("--json", "task", "list", "--column", "Review", "--column", "Done");
    expect(repeated.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(repeated.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--column" } });
    expect((await run("task", "list", "--help")).stdout).toContain("[--column <name>]");
  });
});

test("task list renders every project's tasks once and aligns unequal key widths", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "a", "--name", "Short"], testDir);
    await runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir);
    await runZinn(["task", "create", "A", "--title", "short task", "--description", "short description"], testDir);
    await runZinn(["task", "create", "LONGKEY", "--title", "long task", "--description", "long description"], testDir);

    const result = await runZinn(["task", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain(`A-1       | Backlog | - | short task`);
    expect(lines).toContain(
      `LONGKEY-1 | Backlog | - | long task`,
    );
  });
});

test("task list does not print a missing description as data", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    await runZinn(["task", "create", "NONE", "--title", "title only"], testDir);

    const result = await runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`NONE-1 | Backlog | - | title only`);
    expect(result.stdout).not.toContain("null");
  });
});

test("task list leaves a long multi-line description to task view, which prints it in full", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "PREVIEW", "--name", "Description preview"], testDir);
    const description = `${"A".repeat(40)}\n\t${"B".repeat(50)}`;

    await runZinn(
      ["task", "create", "PREVIEW", "--title", "long description", "--description", description],
      testDir,
    );

    const listResult = await runZinn(["task", "list", "PREVIEW"], testDir);
    const viewResult = await runZinn(["task", "view", "PREVIEW-1"], testDir);

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toBe(`PREVIEW-1 | Backlog | - | long description\n`);
    expect(viewResult.code).toBe(0);
    expect(taskViewContent(viewResult.stdout)).toBe(
      `PREVIEW-1 | Backlog | - | long description\n\n${SECTION_RULE}\nDescription:\n${description}\n`,
    );
  });
});

test("task rows in lists and bulk archive output leave descriptions out, while JSON keeps them", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const descriptions = ["First hidden description", "Second hidden description"];
    await run("project", "create", "ROWS");
    await run("task", "create", "ROWS", "--title", "First", "--description", descriptions[0]!);
    await run("task", "create", "ROWS", "--title", "Second", "--description", descriptions[1]!);

    const rowOutputs = [
      await run("task", "list", "ROWS"),
      await run("task", "archive", "ROWS-1", "ROWS-2"),
      await run("task", "list", "ROWS", "--all"),
      await run("task", "unarchive", "ROWS-1", "ROWS-2"),
    ];

    for (const rowOutput of rowOutputs) {
      expect(rowOutput.code).toBe(0);
      expect(rowOutput.stdout).toContain("ROWS-1");
      expect(rowOutput.stdout).not.toContain("hidden description");
    }

    const listedJson = JSON.parse((await run("task", "list", "ROWS", "--json")).stdout);
    const archivedJson = JSON.parse((await run("task", "archive", "ROWS-1", "ROWS-2", "--json")).stdout);
    expect(listedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
    expect(archivedJson.map((entry: { description: string }) => entry.description)).toEqual(descriptions);
  });
});

test("project-scoped task list aligns column names and follows board order", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "todo first"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "backlog first"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "doing"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "todo second"], testDir);
    await runZinn(["task", "create", "ORDER", "--title", "backlog second"], testDir);

    await runZinn(["task", "move", "ORDER-1", "TODO"], testDir);
    await runZinn(["task", "move", "ORDER-3", "Doing"], testDir);
    await runZinn(["task", "move", "ORDER-4", "TODO"], testDir);

    const result = await runZinn(["task", "list", "ORDER"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "ORDER-2 | Backlog | - | backlog first",
        "ORDER-5 | Backlog | - | backlog second",
        "ORDER-1 | TODO    | - | todo first",
        "ORDER-4 | TODO    | - | todo second",
        "ORDER-3 | Doing   | - | doing",
        "",
      ].join("\n"),
    );
  });
});

test("task list rejects an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    const result = await runZinn(["--json", "task", "list", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "NOSUCH" } });
  });
});

test("task list and search filter by every repeated label", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "FILTER");
    await run("label", "create", "CLI");
    await run("label", "create", "Groom");
    await run("task", "create", "FILTER", "--title", "Both labels", "--label", "CLI", "--label", "Groom");
    await run("task", "create", "FILTER", "--title", "CLI only", "--label", "CLI");
    await run("task", "create", "FILTER", "--title", "Groom only", "--label", "Groom");
    await run("task", "archive", "FILTER-3");

    const listed = JSON.parse(
      (await run("task", "list", "FILTER", "--label", "cli", "--label", "GROOM", "--json")).stdout,
    );
    expect(listed.map((entry: { key: string }) => entry.key)).toEqual(["FILTER-1"]);

    const searched = await run(
      "task",
      "search",
      "labels",
      "FILTER",
      "--label",
      "CLI",
      "--label",
      "Groom",
    );
    expect(searched.code).toBe(0);
    expect(searched.stdout).toContain("FILTER-1");
    expect(searched.stdout).not.toContain("FILTER-2");

    const archived = await run("task", "list", "FILTER", "--archived", "--label", "groom");
    expect(archived.stdout).toContain("FILTER-3");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "list", "--label", "missing")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "label", key: "missing" } });
    expect((await run("task", "search", "labels", "--label", "missing")).code).toBe(1);
  });
});

test("project-scoped task list aligns one- and two-digit task numbers", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "TEN", "--name", "Ten tasks"], testDir);
    for (let number = 1; number <= 10; number++) {
      await runZinn(["task", "create", "TEN", "--title", `task ${number}`], testDir);
    }

    const result = await runZinn(["task", "list", "TEN"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(10);
    expect(lines).toContain(`TEN-1  | Backlog | - | task 1`);
    expect(lines).toContain(`TEN-10 | Backlog | - | task 10`);
  });
});

test("task list prints labels after the title, and a task without labels ends at its title", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    await run("project", "create", "TAGS");
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("label", "create", "docs");
    await run("task", "create", "TAGS", "--title", "No labels");
    await run("task", "create", "TAGS", "--title", "One label", "--label", "bug");
    await run("task", "create", "TAGS", "--title", "Several labels", "--label", "bug", "--label", "cli", "--label", "docs");

    const result = await run("task", "list", "TAGS");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "TAGS-1 | Backlog | - | No labels",
        "TAGS-2 | Backlog | - | One label | bug",
        "TAGS-3 | Backlog | - | Several labels | bug, cli, docs",
        "",
      ].join("\n"),
    );
  });
});
