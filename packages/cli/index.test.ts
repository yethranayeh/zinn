import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import packageJson from "./package.json";
import { runCliInTerminal } from "./testing";
import { backupFiles, CLI_PATH, createDatabase, createEmptyDatabase, databaseSnapshot, runProcessAsync, runZinn, runZinnAs, runZinnWithPipedYes, SECTION_RULE, taskViewContent, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "./test-helpers";
import { routes } from "./src/routes/routes";
import { errorDocumentSchema } from "./src/errors";
import type { Activity } from "@zinn-dev/core";
import { latestVersion, MIGRATIONS } from "../core/src/migrations/registry";
import { MAX_TEXT_BYTES } from "@zinn-dev/core";

// ? End-to-end tests: each case spawns the real bin, so `ZINN_DIR` is passed
// ? per-spawn rather than set on `process.env`. The route table is imported only
// ? to list the commands; nothing in this process opens a database.

const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);

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

test("task move, archive and unarchive align several tasks and note repeated keys", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "A"], testDir);
    await runZinn(["project", "create", "LONG"], testDir);
    await runZinn(["task", "create", "A", "--title", "short key"], testDir);
    await runZinn(["task", "create", "LONG", "--title", "long key"], testDir);

    const moved = await runZinn(["task", "move", "A-1", "LONG-1", "A-1", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe(
      "A-1    | Done | - | short key\nLONG-1 | Done | - | long key\nA-1    | Done | - | short key\n",
    );
    expect(moved.stderr).toContain("A-1");
    expect(moved.stderr).toContain("Done");

    const archived = await runZinn(["task", "archive", "A-1", "LONG-1", "A-1"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "A-1    | Archived | Done | - | short key\nLONG-1 | Archived | Done | - | long key\nA-1    | Archived | Done | - | short key\n",
    );
    expect(archived.stderr).toContain("A-1");

    const unarchived = await runZinn(["task", "unarchive", "LONG-1", "A-1", "LONG-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stdout).toBe(
      "LONG-1 | Active | Done | - | long key\nA-1    | Active | Done | - | short key\nLONG-1 | Active | Done | - | long key\n",
    );
    expect(unarchived.stderr).toContain("LONG-1");
  });
});

test("task move, archive and unarchive change nothing when any task fails", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ATOM"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "active"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "archived"], testDir);
    await runZinn(["task", "archive", "ATOM-2"], testDir);
    const before = (await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout;

    const move = await runZinn(["--json", "task", "move", "ATOM-1", "ATOM-2", "Done"], testDir);
    expect(move.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(move.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", entity: "task", key: "ATOM-2" } });

    const archive = await runZinn(["--json", "task", "archive", "ATOM-1", "ATOM-404"], testDir);
    expect(archive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archive.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "ATOM-404" } });

    const unarchive = await runZinn(["--json", "task", "unarchive", "ATOM-2", "nope"], testDir);
    expect(unarchive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unarchive.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["taskKey"] } });

    expect((await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout).toBe(before);
  });
});

test("task move, archive and unarchive print an object for one task and an array for several with --json", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SHAPE"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "one"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "two"], testDir);

    const moveOne = JSON.parse((await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout);
    expect(moveOne).toMatchObject({ key: "SHAPE-1", column: "Done", changed: true });

    const moveUnchanged = JSON.parse(
      (await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout,
    );
    expect(moveUnchanged).toMatchObject({ key: "SHAPE-1", column: "Done", changed: false });

    const archiveMany = JSON.parse(
      (await runZinn(["task", "archive", "SHAPE-1", "SHAPE-2", "SHAPE-1", "--json"], testDir)).stdout,
    );
    expect(archiveMany).toMatchObject([
      { key: "SHAPE-1", status: "Archived", changed: true },
      { key: "SHAPE-2", status: "Archived", changed: true },
      { key: "SHAPE-1", status: "Archived", changed: false },
    ]);

    const unarchiveOne = JSON.parse(
      (await runZinn(["task", "unarchive", "SHAPE-2", "--json"], testDir)).stdout,
    );
    expect(unarchiveOne).toMatchObject({ key: "SHAPE-2", status: "Active", changed: true });
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

test.serial("task delete prints the task row after Deleted, or after Deletion cancelled for when declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);
    await runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Not in rows", "--priority", "high", "--label", "urgent"],
      testDir,
    );
    const row = "ROW-1 | Backlog | H | one | urgent\n";

    const cancelled = await runCliInTerminal(["task", "delete", "ROW-1"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });
    expect(cancelled.code).toBe(0);
    expect(cancelled.output).toContain(row.trimEnd());
    expect((await runZinn(["task", "list", "ROW"], testDir)).stdout).toBe(row);

    const deleted = await runZinn(["task", "delete", "ROW-1", "--yes"], testDir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain(row.trimEnd());
    expect((await runZinn(["task", "list", "ROW"], testDir)).stdout).toBe("");
  });
});

test("project, column, label and comment edits distinguish no-ops from changes in text and JSON", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async (directory) => {
      const run = (...args: string[]) => runZinn(args, directory);
      expect((await run("project", "create", "EDIT", "--name", "App", "--description", "Alpha\nbeta")).code).toBe(0);
      expect((await run("label", "create", "bug", "--color", "red", "--description", "Alpha\nbeta")).code).toBe(0);
      expect((await run("task", "create", "EDIT", "--title", "Task", "--label", "bug")).code).toBe(0);
      expect((await run("task", "comment", "create", "EDIT-1", "--text", "Alpha\nbeta")).code).toBe(0);
      withTestDb(directory, (db) => {
        db.run("UPDATE project SET updated_at = 1");
        db.run("UPDATE task SET updated_at = 1");
        db.run("UPDATE comment SET updated_at = 1");
      });
      const snapshot = () => withTestDb(directory, (db) => ({
        projects: db.query("SELECT * FROM project ORDER BY id").all(),
        columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
        labels: db.query("SELECT * FROM label ORDER BY id").all(),
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        comments: db.query("SELECT * FROM comment ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
      const before = snapshot();
      const noOps = [
        { args: ["project", "edit", "edit", "--name", " App "], fact: "EDIT", expected: { key: "EDIT", name: "App" } },
        { args: ["project", "edit", "EDIT", "--description", "Alpha\r\nbeta"], fact: "EDIT", expected: { key: "EDIT", description: "Alpha\nbeta" } },
        { args: ["project", "edit", "EDIT", "--description", "Alpha", "--replacing", "Alpha"], fact: "EDIT", expected: { key: "EDIT" } },
        { args: ["project", "column", "edit", "EDIT", "backlog", "--name", " Backlog "], fact: "Backlog", expected: { project: "EDIT", name: "Backlog" } },
        { args: ["label", "edit", "BUG", "--name", " bug ", "--color", "red", "--description", "Alpha\r\nbeta"], fact: "bug", expected: { name: "bug", color: "red" } },
        { args: ["label", "edit", "bug", "--description", "Alpha", "--replacing", "Alpha"], fact: "bug", expected: { name: "bug" } },
        { args: ["task", "comment", "edit", "edit-1#1", "--text", "Alpha\r\nbeta"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1", text: "Alpha\nbeta" } },
        { args: ["task", "comment", "edit", "EDIT-1#1", "--text", "Alpha", "--replacing", "Alpha"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1" } },
      ];
      for (const { args, fact, expected } of noOps) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toContain(fact);
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ ...expected, changed: false });
        } else {
          expect(result.stdout).toContain(fact);
        }
        expect(snapshot()).toEqual(before);
      }
      const edits = [
        { args: ["project", "edit", "EDIT", "--name", "Renamed", "--description", "Alpha\nbeta"], fact: "Renamed", expected: { key: "EDIT", name: "Renamed" } },
        { args: ["project", "column", "edit", "EDIT", "Backlog", "--name", "backlog"], fact: "backlog", expected: { project: "EDIT", name: "backlog" } },
        { args: ["label", "edit", "bug", "--color", "blue", "--description", "Alpha\nbeta"], fact: "bug", expected: { name: "bug", color: "blue" } },
        { args: ["task", "comment", "edit", "EDIT-1#1", "--text", "Edited"], fact: "EDIT-1#1", expected: { key: "EDIT-1#1", text: "Edited" } },
      ];
      for (const { args, fact, expected } of edits) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ ...expected, changed: true });
        } else {
          expect(result.stdout).toContain(fact);
        }
      }
      const after = snapshot();
      expect(after.tasks).toEqual(before.tasks);
      expect(after.activity.length).toBe(before.activity.length + edits.length);
    });
  }
});

test("task edits and label commands report no-ops and mixed changes in text and JSON", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async (directory) => {
      const run = (...args: string[]) => runZinn(args, directory);
      expect((await run("project", "create", "CHANGE")).code).toBe(0);
      for (const name of ["bug", "docs", "later"]) {
        expect((await run("label", "create", name)).code).toBe(0);
      }
      expect((await run("task", "create", "CHANGE", "--title", "First", "--description", "Details", "--label", "bug")).code).toBe(0);
      const snapshot = () => withTestDb(directory, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        labels: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
      const noOps = [
        ["task", "edit", "change-1", "--title", " First "],
        ["task", "edit", "CHANGE-1", "--description", "Details"],
        ["task", "edit", "CHANGE-1", "--priority", "none"],
        ["task", "edit", "CHANGE-1", "--add-label", "BUG", "--remove-label", "docs"],
        ["task", "label", "add", "CHANGE-1", "BUG"],
        ["task", "label", "remove", "CHANGE-1", "docs"],
      ];
      for (const archived of [false, true]) {
        if (archived) {
          expect((await run("task", "archive", "CHANGE-1")).code).toBe(0);
        }
        const before = snapshot();
        for (const args of noOps) {
          const result = await run(...args, ...(json ? ["--json"] : []));
          expect(result.code).toBe(0);
          expect(result.stderr.trim().split("\n")).toHaveLength(1);
          expect(result.stderr).toContain("CHANGE-1");
          if (json) {
            expect(JSON.parse(result.stdout)).toMatchObject({ key: "CHANGE-1", title: "First", labels: ["bug"], changed: false });
          } else {
            expect(result.stdout).toContain("CHANGE-1");
            expect(result.stdout).toContain("First");
            expect(result.stdout).toContain("bug");
          }
          expect(snapshot()).toEqual(before);
        }
      }
      const changes = [
        { args: ["task", "edit", "CHANGE-1", "--title", "Renamed"], labels: ["bug"] },
        { args: ["task", "edit", "CHANGE-1", "--add-label", "bug", "--add-label", "docs"], labels: ["bug", "docs"] },
        { args: ["task", "label", "add", "CHANGE-1", "docs", "later"], labels: ["bug", "docs", "later"] },
        { args: ["task", "label", "remove", "CHANGE-1", "bug", "docs"], labels: ["later"] },
        { args: ["task", "label", "remove", "CHANGE-1", "bug", "later"], labels: [] },
      ];
      for (const { args, labels } of changes) {
        const result = await run(...args, ...(json ? ["--json"] : []));
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ key: "CHANGE-1", title: "Renamed", labels, changed: true });
        } else {
          expect(result.stdout).toContain("CHANGE-1");
          expect(result.stdout).toContain("Renamed");
          for (const name of labels) {
            expect(result.stdout).toContain(name);
          }
        }
      }
    });
  }
});

test("task write commands print JSON with the full task details, unchanged by the row output", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["label", "create", "urgent"], testDir);
    await runZinn(["project", "create", "ROW"], testDir);

    const created = await runZinn(
      ["task", "create", "ROW", "--title", "one", "--description", "Full text", "--priority", "high", "--label", "urgent", "--json"],
      testDir,
    );
    expect(JSON.parse(created.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      is_first: true,
      is_last: false,
      title: "one",
      description: "Full text",
      priority: "high",
      due_at: null,
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    const edited = await runZinn(["task", "edit", "ROW-1", "--title", "uno", "--json"], testDir);
    expect(JSON.parse(edited.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Active",
      column: "Backlog",
      is_first: true,
      is_last: false,
      title: "uno",
      description: "Full text",
      priority: "high",
      due_at: null,
      labels: ["urgent"],
      label_ids: [expect.any(String)],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      changed: true,
    });

    const archived = await runZinn(["task", "archive", "ROW-1", "--json"], testDir);
    expect(JSON.parse(archived.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "ROW-1",
      status: "Archived",
      column: "Backlog",
      is_first: true,
      is_last: false,
      title: "uno",
      description: "Full text",
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

test("project list shows every established project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "LIST", "--name", "Listed"], testDir);

    const result = await runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("LIST");
  });
});

test("task delete removes the task but not its project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "doomed task"], testDir);

    expect((await runZinn(["task", "delete", "KEEP-1", "--yes"], testDir)).code).toBe(0);
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).not.toContain("doomed task");
    expect((await runZinn(["project", "list"], testDir)).stdout).toContain("KEEP");
  });
});

test.serial("task delete keeps the task when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    await runZinn(["task", "create", "KEEP", "--title", "surviving task"], testDir);

    const declined = await runCliInTerminal(["task", "delete", "KEEP-1"], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir }, cwd: testDir, input: "n\n" });
    expect(declined.code).toBe(0);
    expect((await runZinn(["task", "list", "KEEP"], testDir)).stdout).toContain("surviving task");
  });
});

test("task delete requires a valid existing task key", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    expect((await runZinn(["task", "delete"], testDir)).stderr).toContain("Usage: zinn task delete");
    expect(errorDocumentSchema.parse(JSON.parse((await runZinn(["--json", "task", "delete", "INVALID"], testDir)).stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining("INVALID"), details: { field: ["taskKey"] } });
  });
});

test("task edit preserves omitted fields and identity, and accepts empty descriptions", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../core/src/types").Task, []>("SELECT * FROM task").get()!);
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    const before = read();
    expect((await runZinn(["task", "edit", "edit-1", "--title", "New title"], dir)).code).toBe(0);
    const after = read();
    expect(after).toEqual({ ...before, title: "New title", updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(1);
    expect((await runZinn(["task", "edit", "EDIT-1", "--description", ""], dir)).code).toBe(0);
    expect(read().description).toBeNull();
    expect(read().title).toBe("New title");
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    expect((await runZinn(["task", "edit", "EDIT-1", "--title", "New title", "--description", ""], dir)).code).toBe(0);
    expect(read().updated_at).toBe(1);
    expect((await runZinn(["task", "edit", "--description=Changed", "EDIT-1", "--title=--example"], dir)).code).toBe(0);
    expect(read()).toMatchObject({ title: "--example", description: "Changed" });
  });
});

test("task edit rejects invalid requests without partial writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const usage = "Usage: zinn task edit";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "task-key" }, help: expect.stringContaining(usage) }],
      [["EDIT-1"], { code: "invalid_input" }],
      [["EDIT-1", "--title"], { code: "invalid_input", details: { argument: "--title" } }],
      [["EDIT-1", "--description"], { code: "invalid_input", details: { argument: "--description" } }],
      [["EDIT-1", "--unknown", "text"], { code: "invalid_input", details: { argument: "--unknown" } }],
      [["EDIT-1", "extra", "--title", "text"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["EDIT-1", "--title", "one", "--title", "two"], { code: "invalid_input", details: { argument: "--title" } }],
      [["EDIT-1", "--title", ""], { code: "invalid_input", details: { field: ["title"] } }],
      [["EDIT-1", "--title", "   "], { code: "invalid_input", details: { field: ["title"] } }],
      [["EDIT-1", "--title", "", "--description", "Changed"], { code: "invalid_input", details: { field: ["title"] } }],
      [["INVALID", "--title", "text"], { code: "invalid_input", details: { field: ["taskKey"] } }],
      [["EDIT-99", "--title", "text"], { code: "not_found", details: { entity: "task", key: "EDIT-99" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["task", "edit", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
    expect(taskViewContent((await runZinn(["task", "view", "EDIT-1"], dir)).stdout)).toBe(
      `EDIT-1 | Backlog | - | Original\n\n${SECTION_RULE}\nDescription:\nDescription\n`,
    );
  });
});

test("task edit preserves archive state and documents its flags", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await withIsolatedZinnDir(async (dir) => {
      await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
      await runZinn(["task", "create", "EDIT", "--title", "Original"], dir);
      await runZinn(["task", "archive", "EDIT-1"], dir);
      expect((await runZinn(["task", "edit", "EDIT-1", "--title", "Archived edit"], dir)).code).toBe(0);
      expect((await runZinn(["task", "list", "EDIT"], dir)).stdout).toBe("");
      expect((await runZinn(["task", "list", "EDIT", "--archived"], dir)).stdout).toContain("Archived edit");
    });
    const help = await runZinn(["task", "edit", "--help"], testDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--description ''");
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

test.serial("task mutations print the resulting entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "LIFE", "--name", "Responsive"], testDir);

    expect((await runZinn(["task", "create", "LIFE", "--title", "First", "--description", "Description"], testDir)).stdout).toBe(
      `LIFE-1 | Backlog | - | First\n`,
    );
    await runZinn(["task", "create", "LIFE", "--title", "Second"], testDir);
    expect(
      (await runZinn(["task", "edit", "life-1", "--title", "Updated"], testDir)).stdout,
    ).toBe(`LIFE-1 | Backlog | - | Updated\n`);
    expect((await runZinn(["task", "move", "LIFE-1", "TODO"], testDir)).stdout).toBe(
      "LIFE-1 | TODO | - | Updated\n",
    );
    await runZinn(["task", "move", "LIFE-2", "TODO"], testDir);
    expect((await runZinn(["task", "order", "LIFE-2", "top"], testDir)).stdout).toBe(
      "LIFE-2 | TODO | - | Second\n",
    );
    expect((await runZinn(["task", "archive", "LIFE-1"], testDir)).stdout).toBe(
      "LIFE-1 | Archived | TODO | - | Updated\n",
    );
    expect((await runZinn(["task", "unarchive", "LIFE-1"], testDir)).stdout).toBe(
      "LIFE-1 | Active | TODO | - | Updated\n",
    );
    expect((await runZinn(["task", "delete", "LIFE-1", "--yes"], testDir)).stdout).toContain(
      "Deleted LIFE-1 | TODO | - | Updated",
    );
    const declined = await runCliInTerminal(["task", "delete", "LIFE-2"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: testDir, NO_COLOR: "1" },
      cwd: testDir,
      input: "n\n",
    });
    expect(declined.output).toContain("LIFE-2 | TODO | - | Second");
  });
});

// ? Empty strings pass the routers' `== null` guards; core's validation rejects them.
test("empty-string arguments are rejected", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);

    const blankTitle = await runZinn(["--json", "task", "create", "EMPTY", "--title", ""], testDir);
    expect(blankTitle.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankTitle.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["title"] } });

    const blankProject = await runZinn(["--json", "project", "create", "", "--name", ""], testDir);
    expect(blankProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankProject.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["key"] } });
  });
});

// --- ACTIVITY ACTOR

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string | null; actor_email: string | null; actor_kind: string; actor_source: string | null }, []>(
      "SELECT action, actor_name, actor_email, actor_kind, actor_source FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect((await runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });
    expect((await runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });

    expect((await runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human", actor_source: "git-config" });

    expect((await runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null", USER: userInfo().username })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human", actor_source: "os-user" });
  });
});

test("CLI mutations preserve declared identity pairs and metadata without recording no-ops or failures", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const declared = {
      AI_AGENT: "integration-client", ZINN_SESSION_ID: " conversation ", ZINN_THREAD_ID: " child ",
      ZINN_AGENT: " Explore ", ZINN_MODEL: " provider/model ", ZINN_EFFORT: " 0.7 ",
      CLAUDE_CODE_SESSION_ID: "native-session", CODEX_SESSION_ID: "codex-session", CODEX_THREAD_ID: "codex-thread",
    };
    const events = async (): Promise<Array<Activity>> => JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout);
    expect((await runZinnAs(["project", "create", "IDENTITY"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "create", "IDENTITY", "--title", "Tracked"], directory, declared)).code).toBe(0);
    const item = (await events())[0]!;
    expect(item).toMatchObject({
      actor_name: "integration-client", actor_kind: "agent", actor_source: "env:AI_AGENT",
      actor_session_id: "conversation", actor_thread_id: "child", actor_agent: "Explore",
      actor_model: "provider/model", actor_effort: "0.7",
    });
    const before = await events();
    expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", "Tracked"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "move", "IDENTITY-1", "Missing"], directory, declared)).code).toBe(1);
    expect(await events()).toEqual(before);

    const cases: Array<{ env: Record<string, string>; name: string | null; session: string | null; thread: string | null }> = [
      { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-root", CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread" }, name: "claude-code", session: "claude-root", thread: null },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-root" }, name: "codex", session: "codex-root", thread: "codex-root" },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-child" }, name: "codex", session: "codex-root", thread: "codex-child" },
      { env: { CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread", ZINN_THREAD_ID: "explicit-child" }, name: "codex", session: null, thread: "explicit-child" },
      { env: { AGENT: "1", OPENCODE: "1" }, name: "opencode", session: null, thread: null },
      { env: { AGENT: "1" }, name: null, session: null, thread: null },
    ];
    for (const [index, entry] of cases.entries()) {
      expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", `Change ${index}`], directory, entry.env)).code).toBe(0);
      expect((await events())[0]).toMatchObject({
        actor_name: entry.name, actor_kind: "agent", actor_session_id: entry.session, actor_thread_id: entry.thread,
        actor_agent: null, actor_model: null, actor_effort: null,
      });
    }
    const unnamed = (await events())[0]!;
    expect(unnamed.actor_source).toBe("env:AGENT");
    expect((await runZinn(["activity", "list", "--limit", "1"], directory)).stdout).toContain("unknown (agent)");
    const view = await runZinn(["activity", "view", unnamed.id], directory);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("unknown");
    expect(JSON.parse((await runZinn(["activity", "view", unnamed.id, "--json"], directory)).stdout).actor_name).toBeNull();
  });
});

// --- REINDEX (ZINN-49)

test("reindex rebuilds a missing search index from the tasks and comments, archived ones included", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Gadget export"], dir);
    await runZinn(["task", "comment", "create", "IDX-1", "--text", "Needs a spinner"], dir);
    await runZinn(["task", "archive", "IDX-2"], dir);
    const before = databaseSnapshot(dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));

    expect((await runZinn(["task", "search", "spinner"], dir)).code).toBe(1);

    const result = await runZinn(["reindex", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(realpathSync(dir), "data", "zinn.sqlite"),
      taskCount: 2,
    });
    expect((await runZinn(["task", "search", "spinner"], dir)).stdout).toContain("IDX-1");
    expect((await runZinn(["task", "search", "gadget", "--archived"], dir)).stdout).toContain("IDX-2");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    expect((await runZinn(["reindex"], dir)).stdout).toContain("2");
  });
});

test("a missing search index points search and index-updating writes at reindex, changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));
    const countRows = () =>
      withTestDb(dir, (db) =>
        db.query("SELECT (SELECT COUNT(*) FROM comment) AS comments, (SELECT COUNT(*) FROM activity) AS activities").get(),
      );
    const before = { snapshot: databaseSnapshot(dir), rows: countRows() };

    for (const args of [
      ["task", "search", "widget"],
      ["task", "create", "IDX", "--title", "Refused"],
      ["task", "comment", "create", "IDX-1", "--text", "Refused"],
    ]) {
      const plain = await runZinn(args, dir);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("task_search");
      expect(plain.stderr).toContain("zinn reindex");

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error).toMatchObject({ code: "storage", details: { reason: "missing_index" } });
      expect(JSON.parse(json.stderr).error.message).toContain("task_search");
      expect(JSON.parse(json.stderr).error.message).toContain("zinn reindex");
    }
    expect({ snapshot: databaseSnapshot(dir), rows: countRows() }).toEqual(before);
  });
});

test("a missing table other than the search index gets no reindex hint", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_label; DROP TABLE label"));
    const result = await runZinn(["label", "list"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("label");
    expect(result.stderr).not.toContain("reindex");
  });
});

test("reindex refuses when there is no database and creates only telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

test("reindex refuses an empty database file and leaves it empty", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
  });
});

test("reindex refuses a newer database and leaves it unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9 } });

    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

// --- READ-ONLY DATABASES (ZINN-118)

test("a newer database refuses changes, naming both versions and this CLI, while reads still work", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);

    const list = await runZinn(["task", "list", "MIG"], dir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Kept");

    const created = await runZinn(["--json", "task", "create", "MIG", "--title", "Refused"], dir);
    expect(created.code).toBe(1);
    expect(created.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(created.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", databasePath: join(dir, "data", "zinn.sqlite"), schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    for (const fact of ["cli", packageJson.version, CLI_PATH]) {
      expect(JSON.parse(created.stderr).error.message).toContain(fact);
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("task delete on a read-only database refuses before asking for confirmation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinnWithPipedYes(["--json", "task", "delete", "MIG-1"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database" } });
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("an unmarked database is refused, for reads and writes, and left unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    for (const args of [["task", "list", "MIG"], ["task", "create", "MIG", "--title", "Refused"]]) {
      const result = await runZinn(["--json", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0, databasePath: join(dir, "data", "zinn.sqlite") } });
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- LEGACY READS (ZINN-119)

const LEGACY_FLAG = "--allow-legacy-read";

function warningLines(stderr: string, databasePath: string) {
  return stderr.split("\n").filter((line) => line.includes(databasePath));
}

test("--allow-legacy-read reads an unmarked database with one warning on stderr, each invocation needing it again", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const databasePath = join(dir, "data", "zinn.sqlite");

    for (const args of [["task", "list", "MIG", LEGACY_FLAG], [LEGACY_FLAG, "project", "list"], ["task", "view", "MIG-1", LEGACY_FLAG]]) {
      const allowed = await runZinn(args, dir);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain("MIG");
      expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);
      expect(allowed.stderr).toContain(databasePath);
    }

    const refused = await runZinn(["task", "list", "MIG"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(LEGACY_FLAG);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read with --json keeps stdout parseable and refusals as a JSON error", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);

    const allowed = await runZinn(["task", "list", "MIG", "--json", LEGACY_FLAG], dir);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toHaveLength(1);
    expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);

    const refused = await runZinn(["task", "list", "MIG", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr).error.message).toContain(LEGACY_FLAG);
  });
});

test("a --allow-legacy-read after -- is command input, so the database stays refused", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "task", "search", "--", LEGACY_FLAG], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database" } });
    expect(result.stderr).not.toContain("Warning:");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read never lets a command change an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const attempts = [
      ["task", "create", "MIG", "--title", "Refused"],
      ["task", "edit", "MIG-1", "--title", "Refused"],
      ["task", "delete", "MIG-1", "--yes"],
      ["project", "create", "NEW"],
    ];

    for (const args of attempts) {
      const result = await runZinn(["--json", ...args, LEGACY_FLAG], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0 } });

    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("--allow-legacy-read does not warn about a database that has a schema version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, CURRENT_SCHEMA_VERSION);
    const current = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(current.code).toBe(0);
    expect(current.stderr).toBe("");

    withTestDb(dir, (db) => db.run("PRAGMA user_version = 9"));
    const newer = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(newer.code).toBe(0);
    expect(newer.stderr).toBe("");
  });
});

test("help, --version and backup need no --allow-legacy-read for an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    expect((await runZinn(["--help"], dir)).stdout).toContain(LEGACY_FLAG);
    expect((await runZinn(["--version"], dir)).code).toBe(0);

    const backup = await runZinn(["backup", "--json"], dir);
    expect(backup.code).toBe(0);
    expect(backup.stderr).toBe("");
    expect(existsSync(JSON.parse(backup.stdout).path)).toBe(true);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("help and --version open no database, not even one that core refuses", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const commands = [["--version"], ["--help"], ["task", "--help"], ["task", "create", "--help"]];

    for (const args of commands) {
      expect((await runZinn(args, dir)).code).toBe(0);
    }
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);

    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    for (const args of commands) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("simultaneous backup commands create distinct valid snapshots", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BAK"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BAK", "--title", "Saved"], dir)).code).toBe(0);

    const results = await Promise.all(Array.from({ length: 4 }, () => runZinn(["backup", "--json"], dir, { AI_AGENT: "concurrency-test" })));
    const paths = new Set<string>();
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const { path } = JSON.parse(result.stdout) as { path: string };
      expect(paths.has(path)).toBe(false);
      paths.add(path);
      const snapshot = new Database(path, { readonly: true });
      try {
        expect(snapshot.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
        expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    }
  });
});

test.each([
  { type: "project", create: ["EMPTY"], editKey: "EMPTY", read: ["project", "view", "EMPTY"], omitted: ["OMITTED"] },
  { type: "task", create: ["APP", "--title", "Empty"], editKey: "APP-1", read: ["task", "view", "APP-1"], omitted: ["APP", "--title", "Omitted"] },
  { type: "label", create: ["empty"], editKey: "empty", read: ["label", "list"], omitted: ["omitted"] },
])("$type descriptions normalize blank input and preserve meaningful formatting", async (entity) => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    if (entity.type === "task") {
      expect((await run("project", "create", "APP")).code).toBe(0);
    }
    const created = await run(entity.type, "create", ...entity.create, "--description", " \n\t ", "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).description).toBeNull();
    for (const clearInput of ["", " \n\t "]) {
      const description = "  Details\n\tIndented  \n";
      const edited = await run(entity.type, "edit", entity.editKey, "--description", description, "--json");
      expect(edited.code).toBe(0);
      expect(JSON.parse(edited.stdout).description).toBe(description);
      const cleared = await run(entity.type, "edit", entity.editKey, "--description", clearInput, "--json");
      expect(cleared.code).toBe(0);
      expect(JSON.parse(cleared.stdout).description).toBeNull();
    }
    const result = JSON.parse((await run(...entity.read, "--json")).stdout);
    expect((Array.isArray(result) ? result[0] : result).description).toBeNull();
    expect(JSON.parse((await run(entity.type, "create", ...entity.omitted, "--json")).stdout).description).toBeNull();
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

test("project list and write rows show truncated description previews, project view and JSON keep full text, and task rows leave descriptions out", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "  Context\n" + "x".repeat(200);
    const preview = `Context ${"x".repeat(71)}…`;
    expect(preview).toHaveLength(80);
    const taskProject = JSON.parse((await run("project", "create", "PRE", "--description", description, "--json")).stdout);
    await run("task", "create", "PRE", "--title", "Task", "--description", description);
    expect((await run("task", "list", "PRE")).stdout).toBe("PRE-1 | Backlog | - | Task\n");
    expect((await run("project", "list")).stdout).toBe(`PRE | PRE | 1 active | 0 archived | ${preview}\n`);
    expect((await run("project", "view", "PRE")).stdout).toStartWith(`PRE | PRE\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "edit", "PRE", "--description", description)).stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(taskProject.description).toBe(description);
    expect(JSON.parse((await run("project", "view", "PRE", "--json")).stdout).description).toBe(description);
    expect((await run("project", "edit", "PRE", "--description", " \n ")).stdout).toBe("PRE | PRE\n");
  });
});

// --- CONCURRENCY (ZINN-68)

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (let round = 0; round < 3; round++) {
      const store = join(dir, `list-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, () =>
        runZinn(["project", "list", "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // ZINN-458: readers of a store without a database report it and create nothing.
      for (const result of results) {
        expect(result.code).toBe(1);
        expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
      }
      expect(withoutTelemetry(readdirSync(store))).toEqual([]);
    }

    for (let round = 0; round < 3; round++) {
      const store = join(dir, `mixed-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        runZinn(index % 2 === 0
          ? ["project", "list", "--json"]
          : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // A reader that loses the race with the creating writer reports the missing database.
      for (const [index, result] of results.entries()) {
        if (index % 2 === 1 || result.code === 0) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        } else {
          expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
        }
      }
      withTestDb(store, (db) => {
        expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: 20 });
        expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      });
    }

    for (const operation of ["create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        mkdirSync(store);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinn(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
        ));

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        }
        withTestDb(store, (db) => {
          const expectedProjects = operation === "create" ? 40 : 0;
          expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: expectedProjects });
          expect(db.query("SELECT COUNT(*) AS count FROM project_column").get()).toEqual({ count: expectedProjects * 5 });
          expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: expectedProjects });
          expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        });
      }
    }
  });
}, 60_000);

test("concurrent task and comment writes preserve results, counters, order, activity and search", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BEN"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BEN", "--title", "comment-target"], dir)).code).toBe(0);
    const taskKeys = ["BEN-1"];
    const commentKeys: Array<string> = [];
    const titles = ["comment-target"];
    const comments: Array<string> = [];

    for (let round = 0; round < 3; round++) {
      const operations = [
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "task", token: `task${round}n${index}` })),
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "comment", token: `comment${round}n${index}` })),
        ...Array.from({ length: 20 }, () => ({ kind: "read", token: "" })),
      ];
      const results = await Promise.all(operations.map(async ({ kind, token }) => {
        const args = kind === "task" ? ["task", "create", "BEN", "--title", token, "--json"]
          : kind === "comment" ? ["task", "comment", "create", "BEN-1", "--text", token, "--json"]
          : ["task", "list", "BEN", "--json"];
        return { kind, token, ...await runZinn(args, dir, { AI_AGENT: "concurrency-test" }) };
      }));

      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const data = JSON.parse(result.stdout);
        if (result.kind === "task") {
          taskKeys.push(data.key);
          titles.push(result.token);
        } else if (result.kind === "comment") {
          commentKeys.push(data.key);
          comments.push(result.token);
        } else {
          expect(Array.isArray(data)).toBe(true);
        }
      }
    }

    expect(new Set(taskKeys).size).toBe(titles.length);
    expect(new Set(commentKeys).size).toBe(comments.length);
    withTestDb(dir, (db) => {
      const tasks = db.query<{ id: string; number: number; title: string; task_order: string; comment_count: number }, []>(
        "SELECT id, number, title, task_order, comment_count FROM task ORDER BY number",
      ).all();
      const storedComments = db.query<{ number: number; text: string }, []>(
        "SELECT number, text FROM comment ORDER BY number",
      ).all();
      expect(tasks.map((task) => task.title).sort()).toEqual([...titles].sort());
      expect(tasks.map((task) => task.number)).toEqual(Array.from({ length: titles.length }, (_, index) => index + 1));
      expect(new Set(tasks.map((task) => task.task_order)).size).toBe(tasks.length);
      expect(storedComments.map((comment) => comment.text).sort()).toEqual([...comments].sort());
      expect(storedComments.map((comment) => comment.number)).toEqual(Array.from({ length: comments.length }, (_, index) => index + 1));
      expect(tasks[0]!.comment_count).toBe(comments.length);
      expect(db.query("SELECT task_count FROM project WHERE key = 'BEN'").get()).toEqual({ task_count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE entity_type = 'task' AND action = 'create'").get()).toEqual({ count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE action = 'comment_create'").get()).toEqual({ count: comments.length });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: tasks.length });

      for (const task of tasks) {
        expect(db.query("SELECT title FROM task_search WHERE task_id = ?").get(task.id)).toEqual({ title: task.title });
      }
      for (const token of comments) {
        expect(db.query("SELECT task_id FROM task_search WHERE task_search MATCH ?").all(token)).toEqual([{ task_id: tasks[0]!.id }]);
      }
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
}, 60_000);

test.serial("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "WAIT"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinn(["task", "create", "WAIT", "--title", "waited", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).key).toBe("WAIT-1");
      expect(performance.now() - began).toBeGreaterThanOrEqual(250);
      expect(db.query("SELECT title FROM task").all()).toEqual([{ title: "waited" }]);
    } finally {
      clearTimeout(release);
      if (db.inTransaction) {
        db.run("ROLLBACK");
      }
      db.close();
    }
  });
}, 45_000);

test.serial("persistent contention times out without a partial CLI mutation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "LOCK"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinn(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const busy = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(busy).toMatchObject({ code: "storage", details: { reason: "busy", cause: { code: "SQLITE_BUSY" } } });
      expect(readFileSync(busy.details!.logPath!, "utf8")).toContain(busy.details!.cause!.code!);
      expect(performance.now() - began).toBeGreaterThanOrEqual(29_000);
      expect(performance.now() - began).toBeLessThan(40_000);
      expect(db.query("SELECT COUNT(*) AS count FROM task").get()).toEqual({ count: 0 });
      expect(db.query("SELECT task_count FROM project WHERE key = 'LOCK'").get()).toEqual({ task_count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: 1 });
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
  });
}, 45_000);

test("CLI initialization errors expose the underlying message and code", async () => {
  await withIsolatedZinnDir(async (dir) => {
    mkdirSync(join(dir, "data"));
    const contents = "not a SQLite database";
    const path = join(dir, "data", "zinn.sqlite");
    writeFileSync(path, contents);
    const result = await runZinn(["project", "list", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "storage", details: { reason: "not_database", cause: { code: "SQLITE_NOTADB", errcode: 26 } } });

    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});

// --- SETTINGS (ZINN-56)

// ? Runs the bin from cwd with ZINN_DIR unset and a temporary HOME inside testDir, so the settings files choose the store.
async function runZinnFrom(args: Array<string>, testDir: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(testDir, "home") };
  delete env.ZINN_DIR;
  return runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd, env });
}

/** A repository inside testDir holding a zinn.local.json with the given content. */
function repositoryWithSettings(testDir: string, content: string) {
  const repository = join(testDir, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(testDir, "home"));
  writeFileSync(join(repository, "zinn.local.json"), content);

  return repository;
}

test("storage.directory in zinn.local.json chooses the store, from any folder of the repository", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: "../store" } }));
    mkdirSync(join(dir, "store"));
    const nested = join(repository, "src");
    mkdirSync(nested);

    expect((await runZinnFrom(["project", "create", "SET"], dir, repository)).code).toBe(0);
    expect((await runZinnFrom(["project", "list", "--json"], dir, nested)).stdout).toContain('"key": "SET"');
    expect(withTestDb(join(dir, "store"), (db) => db.query("SELECT key FROM project").all())).toEqual([{ key: "SET" }]);
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
  });
});

test("an invalid zinn.local.json fails the command with the file's path, without a stack trace, before creating a store", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: 42 } }));
    const settingsPath = join(realpathSync(repository), "zinn.local.json");

    const result = await runZinnFrom(["project", "create", "SET"], dir, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(settingsPath);
    expect(result.stderr).toContain("storage.directory");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
    expect(readdirSync(repository).sort()).toEqual([".git", "zinn.local.json"]);
  });
});

// --- PARTIAL TEXT EDITS (ZINN-177)

// ? Creates project APP with task APP-1, label bug and comment APP-1#1, all with the given text.
async function seedEditableText(dir: string, text: string) {
  const run = (...args: string[]) => runZinn(args, dir);
  expect((await run("project", "create", "APP", "--description", text)).code).toBe(0);
  expect((await run("task", "create", "APP", "--title", "Task", "--description", text)).code).toBe(0);
  expect((await run("label", "create", "bug", "--description", text)).code).toBe(0);
  expect((await run("task", "comment", "create", "APP-1", "--text", text)).code).toBe(0);

  return run;
}

const storedTextOf = (dir: string) =>
  withTestDb(dir, (db) => ({
    project: db.query<{ text: string | null }, []>("SELECT description AS text FROM project").get()!.text,
    task: db.query<{ text: string | null }, []>("SELECT description AS text FROM task").get()!.text,
    label: db.query<{ text: string | null }, []>("SELECT description AS text FROM label").get()!.text,
    comment: db.query<{ text: string }, []>("SELECT text FROM comment").get()!.text,
  }));

test("oversized partial text edits exit 1 with empty stdout and leave the database unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Seed");
    const atLimit = "a".repeat(MAX_TEXT_BYTES - 4) + "😀";
    withTestDb(dir, (db) => {
      for (const table of ["project", "task", "label"]) {
        db.query(`UPDATE ${table} SET description = ?`).run(atLimit);
      }
      db.query("UPDATE comment SET text = ?").run(atLimit);
    });
    const before = storedTextOf(dir);
    const activities = (await run("activity", "list", "--json")).stdout;
    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      for (const options of [[flag, "x", "--append"], [flag, "😀x", "--replacing", "😀"]]) {
        const result = await run(...args, ...options);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES));
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES + (options.includes("--append") ? 3 : 1)));
        expect(storedTextOf(dir)).toEqual(before);
        expect((await run("activity", "list", "--json")).stdout).toBe(activities);
      }
    }
  });
});

test("CRLF text normalizes through CLI creation, replacement and append for every text field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "  First\r\nSecond\nThird\rEnd  ");
    const normalized = "  First\nSecond\nThird\rEnd  ";
    expect(storedTextOf(dir)).toEqual({ project: normalized, task: normalized, label: normalized, comment: normalized });

    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      const result = await run(...args, flag, "Joined\r\nLine", "--replacing", "First\r\nSecond", "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const entity = JSON.parse(result.stdout);
      expect(entity.description ?? entity.text).toBe("  Joined\nLine\nThird\rEnd  ");
      expect((await run(...args, flag, "Tail\r\n  Indent", "--append")).code).toBe(0);
    }
    const appended = "  Joined\nLine\nThird\rEnd  \n\nTail\n  Indent";
    expect(storedTextOf(dir)).toEqual({ project: appended, task: appended, label: appended, comment: appended });
  });
});

test("--append adds a paragraph to a task description and to a comment's text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "First.\n");

    expect((await run("task", "edit", "APP-1", "--description", "Second.", "--append")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "More.", "--append")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "First.\n\nSecond.", comment: "First.\n\nMore." });
  });
});

test("--replacing swaps one passage in a project description and in a label description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "old sentence, kept");

    expect((await run("project", "edit", "APP", "--description", "new", "--replacing", "old sentence")).code).toBe(0);
    expect((await run("label", "edit", "bug", "--description", "fresh", "--replacing", "old sentence")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ project: "new, kept", label: "fresh, kept" });
  });
});

test("--replacing --all replaces every match and prints the edited object as any edit does", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "board and board");

    const edited = await run("project", "edit", "APP", "--description", "database", "--replacing", "board", "--all");
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain("database and database");
    expect(storedTextOf(dir).project).toBe("database and database");

    const comment = await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "board", "--all");
    expect(comment.code).toBe(0);
    expect(comment.stdout).toContain("x and x");
  });
});

test("--replacing with several matches and no --all fails with the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json"),
      await run("project", "edit", "APP", "--description", "x", "--replacing", "dup", "--json"),
      await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "dup", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(attempt.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 2 } });
      expect(JSON.parse(attempt.stderr).error.message).toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("--replacing with no match fails without the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Some Text");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "some text", "--json"),
      await run("label", "edit", "bug", "--description", "x", "--replacing", "absent", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] } });
      expect(attempt.stderr).not.toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("an empty text with --replacing deletes the match", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "keep\nstale line\n");

    expect((await run("task", "edit", "APP-1", "--description", "", "--replacing", "stale line\n")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "\nstale line")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "keep\n", comment: "keep\n" });
  });
});

test("a modifier edit with --json carries the full resulting text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "One.");

    const task = JSON.parse((await run("task", "edit", "APP-1", "--description", "Two.", "--append", "--json")).stdout);
    const comment = JSON.parse((await run("task", "comment", "edit", "APP-1#1", "--text", "Two.", "--append", "--json")).stdout);

    expect(task.description).toBe("One.\n\nTwo.");
    expect(comment.text).toBe("One.\n\nTwo.");
  });
});

test("a match error with --json uses the usual error shape, with the hint for several matches", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");

    const several = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json");
    const none = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "absent", "--json");

    expect(several.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(several.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 2, field: ["description"] },
    });
    expect(JSON.parse(several.stderr).error.message).toContain("--all");
    expect(errorDocumentSchema.parse(JSON.parse(none.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] },
    });
  });
});

test("the text-edit flags are usage errors without the text flag or in an invalid combination", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");
    const before = storedTextOf(dir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "edit", "APP-1", "--append"], '--append --description'],
      [["project", "edit", "APP", "--name", "New", "--replacing", "a"], '--replacing --description'],
      [["label", "edit", "bug", "--color", "red", "--append"], '--append --description'],
      [["task", "comment", "edit", "APP-1#1", "--replacing", "a"], '--replacing --text'],
      [["task", "edit", "APP-1", "--description", "x", "--all"], '--all --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--all"], '--all --replacing'],
      [["task", "edit", "APP-1", "--description", "x", "--append", "--replacing", "t"], '--append --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--append", "--replacing", "t"], '--append --replacing'],
    ];

    for (const [args, message] of cases) {
      const result = await run(...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const flag of message.split(" ")) {
        expect(result.stderr).toContain(flag);
      }
    }
    expect(storedTextOf(dir)).toEqual(before);
    expect(errorDocumentSchema.parse(JSON.parse((await run("task", "edit", "APP-1", "--append", "--json")).stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--description" },
    });
  });
});

test("core's value rules for the text-edit flags identify the rejected field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    const blankAppend = await run("task", "edit", "APP-1", "--description", " ", "--append", "--json");
    const emptyFind = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "", "--json");
    const blankComment = await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "text", "--json");

    expect(blankAppend.code).toBe(1);
    expect(blankAppend.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankAppend.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "append"] } });
    expect(emptyFind.code).toBe(1);
    expect(emptyFind.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(emptyFind.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "find"] } });
    expect(blankComment.code).toBe(1);
    expect(blankComment.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankComment.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [] } });
  });
});

test("the text-edit flags are limited to the edit commands and listed in their help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    expect((await run("task", "create", "APP", "--title", "T", "--append")).code).toBe(1);
    expect((await run("task", "comment", "create", "APP-1", "--text", "x", "--append")).code).toBe(1);

    for (const command of [["task", "edit"], ["project", "edit"], ["label", "edit"], ["task", "comment", "edit"]]) {
      const help = (await run(...command, "--help")).stdout;
      expect(help).toContain("[--append|--replacing <old> [--all]]");
      expect(help).toContain("--append");
    }
  });
});
