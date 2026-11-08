import { expect, test } from "bun:test";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { runCliInTerminal } from "../testing";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

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
