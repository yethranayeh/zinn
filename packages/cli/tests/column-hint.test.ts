import type { ErrorCode } from "../src/errors";

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation";
import { errorDocumentSchema } from "../src/errors";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

async function seed(directory: string) {
  for (const args of [
    ["project", "create", "SHOP"], ["project", "create", "OTHER"],
    // Multi-word names are what the hints are for.
    ["project", "column", "create", "--category", "in_progress", "SHOP", "In Progress"],
    ["project", "column", "create", "--category", "in_progress", "OTHER", "In Progress"],
    ["project", "column", "create", "--category", "todo", "SHOP", "Needs Review"],
    ["task", "create", "SHOP", "--title", "First"],
    ["task", "create", "SHOP", "--title", "Second"],
    ["task", "create", "OTHER", "--title", "Other"],
  ]) {
    expect((await runZinn(args, directory)).code).toBe(0);
  }
}

function snapshot(directory: string) {
  return withTestDb(directory, db => ({
    version: db.query("PRAGMA user_version").get(),
    schema: db.query("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    projects: db.query("SELECT * FROM project ORDER BY id").all(),
    columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
    tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    activity: db.query("SELECT * FROM activity ORDER BY id").all(),
  }));
}

function suggestion(stderr: string, json: boolean) {
  const message = json ? errorDocumentSchema.parse(JSON.parse(stderr)).error.message : stderr.split("\n\n")[0]!;
  const start = message.indexOf("zinn ");
  expect(start).toBeGreaterThanOrEqual(0);
  return message.slice(start);
}

async function runSuggestion(command: string, directory: string) {
  return runProcessAsync(["/bin/sh", "-c", command.replace(/^zinn /, 'exec bun "$1" '), "column-hint", CLI_PATH], {
    cwd: directory,
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory },
  });
}

test("split-column hints cover six commands, retain error facts and execute only when entered", async () => {
  const cases: Array<{ args: string[]; code: ErrorCode; correctedExit: number }> = [
    { args: ["project", "column", "new", "SHOP", "--category", "todo", "In", "Progress"], code: "invalid_input", correctedExit: 1 },
    { args: ["project", "column", "edit", "SHOP", "In", "Progress", "--name", "Working"], code: "invalid_input", correctedExit: 0 },
    { args: ["project", "column", "order", "SHOP", "In", "Progress", "first"], code: "invalid_input", correctedExit: 0 },
    { args: ["project", "column", "order", "SHOP", "Review", "before", "In", "Progress"], code: "invalid_input", correctedExit: 0 },
    { args: ["task", "new", "SHOP", "--title", "A 'quoted' $(touch marker) title", "--priority", "HIGH", "--column", "In", "Progress"], code: "invalid_input", correctedExit: 0 },
    { args: ["task", "ls", "SHOP", "--column=In", "Progress"], code: "invalid_input", correctedExit: 0 },
    { args: ["task", "move", "shop-1", "OTHER-1", "In", "Progress"], code: "not_found", correctedExit: 0 },
  ];
  for (const json of [false, true]) {
    for (const { args, code, correctedExit } of cases) {
      await withIsolatedZinnDir(async directory => {
        await seed(directory);
        const before = snapshot(directory);
        const input = json ? ["--json", ...args] : args;
        const result = await runZinn(input, directory);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        if (json) {
          const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
          expect(failure.code).toBe(code);
          expect(failure.help).toContain("Usage: zinn");
          expect(failure.details).toBeDefined();
        } else {
          expect(result.stderr).toContain("Usage: zinn");
        }
        const command = suggestion(result.stderr, json);
        expect(command).toContain(args.slice(0, 2).join(" "));
        expect(command).toContain("In Progress");
        expect(snapshot(directory)).toEqual(before);
        const corrected = await runSuggestion(command, directory);
        expect(corrected.code).toBe(correctedExit);
        expect(existsSync(join(directory, "marker"))).toBe(false);
        if (args[1] === "new") {
          expect(command).toContain("--priority HIGH");
          expect(withTestDb(directory, db => db.query("SELECT title FROM task WHERE number = 3").get()))
            .toEqual({ title: "A 'quoted' $(touch marker) title" });
        }
        if (args[1] === "move") {
          expect(withTestDb(directory, db => db.query("SELECT project_column.name FROM task JOIN project_column ON task.column_id = project_column.id WHERE task.number = 1 ORDER BY task.id").all()))
            .toEqual([{ name: "In Progress" }, { name: "In Progress" }]);
        }
        if (correctedExit === 1 || args[1] === "ls") {
          expect(snapshot(directory)).toEqual(before);
        }
      });
    }
  }
}, 30_000);

test("column-option hints use explicit, default and all-project scope without discarding real projects", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "Ready For Review"], directory)).code).toBe(0);
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultProject: "SHOP" }));
    for (const args of [
      ["task", "create", "--title", "Default", "--column", "In", "Progress"],
      ["task", "list", "--column", "In", "Progress"],
      ["task", "list", "--all-projects", "--column", "In", "Progress"],
      ["task", "list", "--all-projects", "--column", "Ready", "For", "Review"],
    ]) {
      const before = snapshot(directory);
      const result = await runZinn([...args, "--json"], directory);
      expect(result.code).toBe(1);
      const command = suggestion(result.stderr, true);
      expect(snapshot(directory)).toEqual(before);
      expect((await runSuggestion(command, directory)).code).toBe(0);
    }
    writeFileSync(join(directory, "settings.json"), "{}");
    const allProjects = await runZinn(["task", "list", "--column", "Needs", "Review", "--json"], directory);
    expect(allProjects.code).toBe(1);
    expect((await runSuggestion(suggestion(allProjects.stderr, true), directory)).code).toBe(0);
    const noDefault = await runZinn(["task", "create", "--title", "No scope", "--column", "In", "Progress", "--json"], directory);
    expect(noDefault.code).toBe(1);
    expect(JSON.parse(noDefault.stderr).error.message).not.toContain("zinn ");
    expect((await runZinn(["project", "create", "PROGRESS"], directory)).code).toBe(0);
    const realProject = await runZinn(["task", "create", "SHOP", "--title", "Explicit", "--column", "In", "Progress", "--json"], directory);
    expect(realProject.code).toBe(1);
    expect(JSON.parse(realProject.stderr).error.message).not.toContain("zinn ");
  });
});

test("column hints preserve shell-sensitive names, option values, aliases and separator boundaries", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    const name = "QA O'Brien; $(touch marker)";
    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", name], directory)).code).toBe(0);
    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "In --json"], directory)).code).toBe(0);
    for (const args of [
      ["project", "column", "edit", "--name", "After 'review'", "SHOP", ...name.split(" ")],
      ["--json", "project", "--allow-legacy-read", "column", "edit", "--name=After", "SHOP", "--", "In", "--json"],
      ["project", "column", "order", "SHOP", "In", "Progress", "after", "Needs", "Review"],
    ]) {
      const before = snapshot(directory);
      const json = args[0] === "--json";
      const result = await runZinn(args, directory);
      expect(result.code).toBe(1);
      const command = suggestion(result.stderr, json);
      expect(snapshot(directory)).toEqual(before);
      expect((await runSuggestion(command, directory)).code).toBe(0);
      expect(existsSync(join(directory, "marker"))).toBe(false);
      if (json) {
        expect(command).toContain(" -- ");
        expect(command).toContain("In --json");
      }
    }
  });
});

test("unmatched or unrelated column failures keep their original error and change nothing", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "Three Word Column"], directory)).code).toBe(0);
    expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "SHOP-2 Progress"], directory)).code).toBe(0);
    expect((await runZinn(["project", "column", "edit", "OTHER", "In Progress", "--name", "Working"], directory)).code).toBe(0);
    expect((await runZinn(["task", "archive", "SHOP-2"], directory)).code).toBe(0);
    const before = snapshot(directory);
    for (const args of [
      ["project", "column", "create", "--category", "todo", "SHOP", "No", "Match"],
      ["project", "column", "edit", "SHOP", "In Progress", "--name", "Needs", "Review"],
      ["project", "column", "edit", "SHOP", "In", "Progress"],
      ["project", "column", "order", "SHOP", "In", "Progress", "sideways"],
      ["task", "create", "SHOP", "--column", "In", "Progress"],
      ["task", "list", "SHOP", "--column", "In", "Progress", "--column", "In"],
      ["task", "list", "SHOP", "--column", "In", "--bogus", "Progress"],
      ["task", "move", "SHOP-1", "OTHER-1", "In", "Progress"],
      ["task", "move", "SHOP-1", "SHOP-2", "Progress"],
      ["task", "move", "SHOP-1", "Three", "Word", "Column"],
      ["task", "move", "SHOP-2", "In", "Progress"],
      ["task", "relation", "create", "SHOP-1", "related", "SHOP-2"],
    ]) {
      const result = await runZinn([...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error.message).not.toContain("zinn ");
      expect(snapshot(directory)).toEqual(before);
    }
  });
});

test("column order hints preserve a recognized direction rather than absorb it into a name", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async directory => {
      await seed(directory);
      for (const name of ["A after B", "C"]) {
        expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", name], directory)).code).toBe(0);
      }
      const args = ["project", "column", "order", "SHOP", "A", "after", "B", "before", "C"];
      const input = json ? [...args, "--json"] : args;
      const before = snapshot(directory);
      const rejected = await runZinn(input, directory);
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe("");
      if (json) {
        const failure = errorDocumentSchema.parse(JSON.parse(rejected.stderr)).error;
        expect(failure).toMatchObject({ code: "invalid_input", details: { field: [] } });
        expect(failure.help).toContain("Usage: zinn project column order");
        expect(failure.message).not.toContain("zinn ");
      } else {
        expect(rejected.stderr.split("\n\n")[0]).not.toContain("zinn ");
        expect(rejected.stderr).toContain("Usage: zinn project column order");
      }
      expect(snapshot(directory)).toEqual(before);

      for (const name of ["A", "B before C"]) {
        expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", name], directory)).code).toBe(0);
      }
      const beforeHint = snapshot(directory);
      const result = await runZinn(input, directory);
      expect(result.code).toBe(1);
      const command = suggestion(result.stderr, json);
      expect(command).toContain("SHOP A after 'B before C'");
      expect(snapshot(directory)).toEqual(beforeHint);
      expect((await runSuggestion(command, directory)).code).toBe(0);
      const orderedNames = withTestDb(directory, db => db.query<{ name: string }, []>(
        "SELECT name FROM project_column WHERE project_id = (SELECT id FROM project WHERE key = 'SHOP') ORDER BY column_order",
      ).all().map(entry => entry.name));
      expect(orderedNames.indexOf("A")).toBe(orderedNames.indexOf("B before C") + 1);
    });
  }
});

test("column order suppresses ambiguous split-source groupings and bulk move can diagnose a mistaken task-key fragment", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    for (const name of ["A B", "C before D", "A B after C", "D", "Progress"]) {
      expect((await runZinn(["project", "column", "create", "--category", "todo", "SHOP", name], directory)).code).toBe(0);
    }
    const before = snapshot(directory);
    const ambiguous = await runZinn(["project", "column", "order", "SHOP", "A", "B", "after", "C", "before", "D", "--json"], directory);
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.stderr).error.message).not.toContain("zinn ");
    expect(snapshot(directory)).toEqual(before);
    const mistakenKey = await runZinn(["task", "move", "SHOP-1", "In", "Progress", "--json"], directory);
    expect(mistakenKey.code).toBe(1);
    expect(JSON.parse(mistakenKey.stderr).error).toMatchObject({ code: "invalid_input", details: { field: ["taskKey"] } });
    expect(snapshot(directory)).toEqual(before);
    expect((await runSuggestion(suggestion(mistakenKey.stderr, true), directory)).code).toBe(0);
  });
});

test("syntax-error column lookups neither create absent storage nor migrate or bypass legacy storage", async () => {
  await withIsolatedZinnDir(async directory => {
    const args = ["project", "column", "edit", "SHOP", "In", "Progress", "--name", "Working", "--json"];
    const absent = await runZinn(args, directory);
    expect(absent.code).toBe(1);
    expect(JSON.parse(absent.stderr).error.message).not.toContain("zinn ");
    expect(existsSync(join(directory, "data"))).toBe(false);
    await seed(directory);
    for (const version of [1, 0, 999]) {
      withTestDb(directory, db => db.run(`PRAGMA user_version = ${version}`));
      const before = snapshot(directory);
      const result = await runZinn(args, directory);
      expect(result.code).toBe(1);
      if (version === 0) {
        expect(JSON.parse(result.stderr).error.message).not.toContain("zinn ");
        const acknowledged = await runZinn(["--allow-legacy-read", ...args], directory);
        expect(suggestion(acknowledged.stderr, true)).toContain("In Progress");
      } else {
        expect(suggestion(result.stderr, true)).toContain("In Progress");
      }
      expect(snapshot(directory)).toEqual(before);
      expect(existsSync(join(directory, "backups"))).toBe(false);
    }
  });
});
