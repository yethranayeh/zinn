import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

import packageJson from "./package.json";

// ? End-to-end tests: each case spawns the real bin, so there is no module-level
// ? import of core here and `ZINN_DIR` is passed per-spawn rather than set on
// ? `process.env`. Subprocesses are the only option while `quit()` calls
// ? `process.exit` — see the refactor TODO at the bottom of this file.
//
// ? `.todo` cases below cover behavior that cannot be asserted yet. Bun skips
// ? them by default; `bun test --todo` runs them and fails any that *pass*
// ? ("marked as todo but passes"), so each one retires itself once its blocker
// ? is built.

const PREFIX = join(tmpdir(), "zinntest-");
const TEST_DIR = mkdtempSync(PREFIX);
// ? Resolved from this file so the suite does not depend on the cwd it is run from.
const CLI_PATH = join(import.meta.dir, "index.ts");
const GRAY_BACKLOG = "\x1b[90mBacklog\x1b[39m";
const GREEN_DONE = "\x1b[32mDone\x1b[39m";

afterAll(() => {
  if (!TEST_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

function removeIsolatedZinnDir(testDir: string) {
  if (!testDir.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${testDir}": not a ${PREFIX}* directory`);
  }

  rmSync(testDir, { recursive: true, force: true });
}

function withIsolatedZinnDir(run: (testDir: string) => void) {
  const testDir = mkdtempSync(PREFIX);

  try {
    run(testDir);
  } finally {
    removeIsolatedZinnDir(testDir);
  }
}

// ? Same as withIsolatedZinnDir, but removes the directory only after an async run settles.
async function withIsolatedZinnDirAsync(run: (testDir: string) => Promise<void>) {
  const testDir = mkdtempSync(PREFIX);

  try {
    await run(testDir);
  } finally {
    removeIsolatedZinnDir(testDir);
  }
}

function runZinn(
  args: Array<string>,
  testDir = TEST_DIR,
  additionalEnv: Record<string, string> = {},
) {
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ...additionalEnv, ZINN_DIR: testDir },
  });

  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode,
  };
}

function runZinnWithConfirmation(args: Array<string>, testDir = TEST_DIR) {
  const proc = Bun.spawnSync(
    ["/bin/sh", "-c", 'printf "y\\n" | exec bun "$@"', "zinn-confirm", CLI_PATH, ...args],
    { env: { ...process.env, ZINN_DIR: testDir } },
  );

  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode,
  };
}

// Unlike runZinn's synchronous subprocess, this lets independent CLI writers overlap.
async function runZinnAsync(args: Array<string>, testDir: string) {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    env: { ...process.env, ZINN_DIR: testDir, AI_AGENT: "concurrency-test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

// ? Runs the CLI in a pseudo-terminal, so stdout is a TTY and text output is colored.
// ? stdout and stderr arrive merged, and the terminal's "\r\n" line endings are normalized.
async function runZinnInTerminal(
  args: Array<string>,
  testDir = TEST_DIR,
  additionalEnv: Record<string, string> = {},
) {
  const decoder = new TextDecoder();
  const terminalClosed = Promise.withResolvers<void>();
  let output = "";

  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ...additionalEnv, ZINN_DIR: testDir },
    terminal: {
      cols: 200,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
      exit: () => terminalClosed.resolve(),
    },
  });

  const code = await proc.exited;
  await terminalClosed.promise;
  proc.terminal!.close();

  return { output: output.replaceAll("\r\n", "\n"), code };
}

function withTestDb<T>(testDir: string, inspect: (db: Database) => T) {
  const db = new Database(join(testDir, "data", "zinn.sqlite"));
  db.run("PRAGMA foreign_keys = ON;");

  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

// --- ENTRYPOINT

test("bare invocation shows root help and exits zero", () => {
  const result = runZinn([]);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result).toEqual(runZinn(["--help"]));
});

test("--version and -v print the CLI package version and exit zero", () => {
  withIsolatedZinnDir((testDir) => {
    const longVersion = runZinn(["--version"], testDir);
    const shortVersion = runZinn(["-v"], testDir);

    expect(longVersion.code).toBe(0);
    expect(longVersion.stdout).toBe(`${packageJson.version}\n`);
    expect(longVersion.stderr).toBe("");
    expect(shortVersion).toEqual(longVersion);
  });
});

test("root help supports -h and --help and lists commands", () => {
  const longHelp = runZinn(["--help"]);
  const shortHelp = runZinn(["-h"]);

  expect(longHelp.code).toBe(0);
  expect(longHelp.stdout).toContain("ZINN - A kanban workflow in the terminal");
  expect(longHelp.stdout).toContain("project column {create|list|edit|order}");
  expect(longHelp.stdout).toContain("project {create|list|view|edit|delete}");
  expect(longHelp.stdout).toContain("task {create|list|search|view|edit|move|order|archive|unarchive|delete}");
  expect(longHelp.stdout).toContain("task comment {create|list|edit|delete}");
  expect(longHelp.stdout).toContain("\n  backup\n");
  expect(longHelp.stdout).toContain("-v, --version  Show version");
  expect(shortHelp).toEqual(longHelp);
});

// --- ROUTING

test("an unrecognized command exits nonzero", () => {
  const result = runZinn(["task", "destroy", "WIP"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unrecognized command");
});

test("a nested route resolves past its namespace", () => {
  runZinn(["project", "create", "NEST", "--name", "Nested"]);

  // ? `project column list` is three tokens deep; proves the router peels the
  // ? namespace prefix and forwards only "NEST" as the command args.
  const result = runZinn(["project", "column", "list", "NEST"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Backlog");
});

test("namespace help lists its commands without running one", () => {
  const taskHelp = runZinn(["task", "--help"]);
  const projectHelp = runZinn(["project", "-h"]);
  const columnHelp = runZinn(["project", "column", "--help"]);

  expect(taskHelp.code).toBe(0);
  expect(taskHelp.stdout).toContain("Usage: zinn task <command>");
  expect(taskHelp.stdout).toContain(
    "  {create|list|search|view|edit|move|order|archive|unarchive|delete}",
  );
  expect(taskHelp.stdout).toContain("  relation {create|list|delete}");
  expect(taskHelp.stdout).not.toContain("  task ");
  expect(projectHelp.code).toBe(0);
  expect(projectHelp.stdout).toContain("  {create|list|view|edit|delete}");
  expect(projectHelp.stdout).toContain("  column {create|list|edit|order}");
  expect(projectHelp.stdout).not.toContain("  project ");
  expect(columnHelp.code).toBe(0);
  expect(columnHelp.stdout).toContain("Usage: zinn project column <command>");
  expect(columnHelp.stdout).toContain("  {create|list|edit|order}");
  expect(columnHelp.stdout).not.toContain("  column ");
});

test("every command help exits cleanly instead of running the command", () => {
  const commands = [
    ["project", "create"],
    ["project", "list"],
    ["project", "view"],
    ["project", "delete"],
    ["project", "column", "create"],
    ["project", "column", "edit"],
    ["project", "column", "list"],
    ["project", "column", "order"],
    ["task", "create"],
    ["task", "list"],
    ["task", "search"],
    ["task", "view"],
    ["task", "edit"],
    ["project", "edit"],
    ["task", "move"],
    ["task", "order"],
    ["task", "delete"],
    ["task", "archive"],
    ["task", "unarchive"],
    ["task", "comment", "create"],
    ["task", "comment", "list"],
    ["task", "comment", "edit"],
    ["task", "comment", "delete"],
    ["backup"],
  ];

  for (const command of commands) {
    const result = runZinn([...command, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: zinn ${command.join(" ")}`);
  }
});

// --- PROJECT

test("project create seeds the default columns", () => {
  expect(runZinn(["project", "create", "WIP", "--name", "Work"]).code).toBe(0);

  const listed = runZinn(["project", "column", "list", "WIP", "--json"]);

  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual([
    { name: "Backlog" },
    { name: "TODO" },
    { name: "In Progress" },
    { name: "Review" },
    { name: "Done" },
  ]);
});

test("project create requires a key", () => {
  const result = runZinn(["project", "create"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Project key must be specified");
});

test("project create defaults the stored name to the uppercase key and allows a later rename", () => {
  withIsolatedZinnDir((testDir) => {
    const created = runZinn(["project", "create", "site"], testDir);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("SITE | SITE\n");
    withTestDb(testDir, (db) => {
      expect(db.query("SELECT key, name FROM project").get()).toEqual({
        key: "SITE",
        name: "SITE",
      });
    });

    const edited = runZinn(["project", "edit", "SITE", "--name", "Website refresh"], testDir);
    expect(edited.code).toBe(0);
    expect(runZinn(["project", "list"], testDir).stdout).toBe("SITE | Website refresh\n");
  });
});

test("project create rejects extra positionals and invalid name flags", () => {
  withIsolatedZinnDir((testDir) => {
    for (const args of [
      ["SITE", "Website"],
      ["SITE", "--name"],
      ["SITE", "--name", "First", "--name", "Second"],
      ["SITE", "--title", "Website"],
    ]) {
      expect(runZinn(["project", "create", ...args], testDir).code).toBe(1);
    }
    expect(runZinn(["project", "list"], testDir).stdout).toBe("");
  });
});

test("project create rejects a duplicate key regardless of casing", () => {
  expect(runZinn(["project", "create", "DUP", "--name", "First"]).code).toBe(0);

  const second = runZinn(["project", "create", "dup", "--name", "Second"]);

  expect(second.code).toBe(1);
  expect(second.stderr).toContain(`Project with key "DUP" already exists!`);
});

test("project column create rejects a duplicate name regardless of casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], testDir);
    expect(runZinn(["project", "column", "create", "COL", "Later"], testDir).code).toBe(0);

    const duplicate = runZinn(["project", "column", "create", "COL", "later"], testDir);

    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain(
      `There is already a "later" column`,
    );
    withTestDb(testDir, (db) => {
      const matches = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_column WHERE project_id = (SELECT id FROM project WHERE key = 'COL') AND LOWER(name) = 'later'",
        )
        .get();

      expect(matches?.count).toBe(1);
    });
  });
});

test("project column create trims names and rejects invalid ones without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    for (const [name, message] of [
      [" done ", `There is already a "done" column`],
      ["   ", "Column name cannot be blank"],
      ["Next\nDone", "Column name cannot contain line breaks or control characters"],
    ]) {
      const result = runZinn(["project", "column", "create", "COL", name!], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message!);
      expect(read()).toEqual(before);
    }

    expect(runZinn(["project", "column", "create", "COL", " Later "], dir).stdout).toBe("COL | Later\n");
  });
});

test("project column names are unique only within a project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);

    const alpha = runZinn(["project", "column", "create", "ALPHA", "QA"], testDir);
    const beta = runZinn(["project", "column", "create", "BETA", "qa"], testDir);

    expect(alpha.code).toBe(0);
    expect(beta.code).toBe(0);
  });
});

test("project column edit renames a column in place and keeps its tasks", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    runZinn(["task", "create", "COL", "--title", "Stays put"], dir);
    runZinn(["task", "move", "COL-1", "todo"], dir);
    const readColumns = () =>
      withTestDb(dir, (db) => db.query("SELECT * FROM project_column ORDER BY column_order").all());
    const before = readColumns();

    const renamed = runZinn(["project", "column", "edit", "col", "todo", "--name", " Next up "], dir);
    expect(renamed).toEqual({ stdout: "COL | Next up\n", stderr: "", code: 0 });
    expect(runZinn(["project", "column", "list", "COL"], dir).stdout).toBe(
      "Backlog\nNext up\nIn Progress\nReview\nDone\n",
    );
    expect(readColumns()).toEqual(
      before.map((row: any) => (row.name === "TODO" ? { ...row, name: "Next up" } : row)),
    );
    expect(runZinn(["task", "view", "COL-1", "--json"], dir).stdout).toContain(`"column": "Next up"`);

    const caseOnly = runZinn(["project", "column", "edit", "COL", "next up", "--name", "NEXT UP", "--json"], dir);
    expect(JSON.parse(caseOnly.stdout)).toEqual({ project: "COL", name: "NEXT UP" });
    expect(runZinn(["project", "column", "edit", "COL", "--name=--example", "NEXT UP"], dir).stdout).toBe(
      "COL | --example\n",
    );
  });
});

test("project column edit rejects invalid requests without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    const cases: Array<[string[], string]> = [
      [[], "Both the project key and the column name must be specified"],
      [["COL"], "Both the project key and the column name must be specified"],
      [["COL", "TODO", "extra", "--name", "Next"], "Both the project key and the column name must be specified"],
      [["COL", "TODO"], "Provide an edit flag: --name"],
      [["COL", "TODO", "--name"], "argument missing"],
      [["COL", "TODO", "--title", "Next"], "Unknown option"],
      [["COL", "TODO", "--name", "One", "--name", "Two"], "only be specified once"],
      [["COL", "TODO", "--name", "   "], "Column name cannot be blank"],
      [["COL", "TODO", "--name", "Next\nDone"], "Column name cannot contain line breaks or control characters"],
      [["COL", "TODO", "--name", "done"], `There is already a "done" column`],
      [["COL", "Missing", "--name", "Next"], `Columns does not have a column named "Missing"`],
      [["NOPE", "TODO", "--name", "Next"], `Project with key "NOPE" does not exist!`],
    ];
    for (const [args, message] of cases) {
      const result = runZinn(["project", "column", "edit", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }

    const unchanged = runZinn(["project", "column", "edit", "COL", "todo", "--name", "TODO"], dir);
    expect(unchanged).toEqual({ stdout: "COL | TODO\n", stderr: "", code: 0 });
    expect(read()).toEqual(before);
  });
});

test("project column order moves a column in every direction and prints it", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const listColumns = () => runZinn(["project", "column", "list", "COL"], dir).stdout.trim().split("\n");

    expect(runZinn(["project", "column", "order", "col", "review", "first"], dir)).toEqual({
      stdout: "COL | Review\n",
      stderr: "",
      code: 0,
    });
    expect(listColumns()).toEqual(["Review", "Backlog", "TODO", "In Progress", "Done"]);

    const steps: Array<[string[], string[]]> = [
      [["Review", "next"], ["Backlog", "Review", "TODO", "In Progress", "Done"]],
      [["Review", "last"], ["Backlog", "TODO", "In Progress", "Done", "Review"]],
      [["Review", "previous"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
      [["todo", "after", "DONE"], ["Backlog", "In Progress", "Review", "Done", "TODO"]],
      [["todo", "before", "in progress"], ["Backlog", "TODO", "In Progress", "Review", "Done"]],
    ];
    for (const [args, expected] of steps) {
      expect(runZinn(["project", "column", "order", "COL", ...args], dir).code).toBe(0);
      expect(listColumns()).toEqual(expected);
    }

    const json = runZinn(["project", "column", "order", "COL", "done", "first", "--json"], dir);
    expect(JSON.parse(json.stdout)).toEqual({ project: "COL", name: "Done" });
  });
});

test("project column order rejects invalid requests and skips no-ops without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "COL", "--name", "Columns"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project_column").all());
    const before = read();
    const cases: Array<[string[], string]> = [
      [[], "Both the project key and the column name must be specified"],
      [["COL"], "Both the project key and the column name must be specified"],
      [["COL", "TODO"], "Order direction must be specified"],
      [["COL", "TODO", "sideways"], `Unknown order direction "sideways"`],
      [["COL", "TODO", "top"], `Unknown order direction "top"`],
      [["COL", "TODO", "before"], `Target column must be specified for "before"`],
      [["COL", "TODO", "before", "Done", "Review"], "Only one target column can be specified"],
      [["COL", "TODO", "first", "Done"], `Order direction "first" does not accept a target column`],
      [["COL", "   ", "first"], "Column name cannot be blank"],
      [["COL", "Missing", "first"], `Columns does not have a column named "Missing"`],
      [["COL", "TODO", "after", "Missing"], `Columns does not have a column named "Missing"`],
      [["NOPE", "TODO", "first"], `Project with key "NOPE" does not exist!`],
    ];
    for (const [args, message] of cases) {
      const result = runZinn(["project", "column", "order", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }

    for (const args of [["backlog", "first"], ["Done", "next"], ["TODO", "after", "backlog"], ["TODO", "before", "todo"]]) {
      const unchanged = runZinn(["project", "column", "order", "COL", ...args], dir);
      expect(unchanged.code).toBe(0);
      expect(unchanged.stderr).toBe("");
      expect(read()).toEqual(before);
    }
  });
});

test("project delete accepts a non-standardized key and removes its columns and tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "GONE", "--name", "Doomed"], testDir);
    runZinn(["task", "create", "GONE", "--title", "Doomed task"], testDir);
    runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    expect(
      runZinnWithConfirmation(["project", "delete", "gone"], testDir).code,
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

test("project delete keeps the project when confirmation is declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Kept"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "Kept task"], testDir);

    const result = runZinn(["project", "delete", "keep"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Deletion cancelled for KEEP | Kept");
    expect(runZinn(["project", "list"], testDir).stdout).toContain("KEEP | Kept");
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).toContain("Kept task");
  });
});

test("project delete rejects an unknown key", () => {
  const result = runZinn(["project", "delete", "NOSUCH"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Project with key "NOSUCH" does not exist!`);
});

test("project list on an empty database exits cleanly without inventing a row", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("project list renders every project once and aligns unequal key widths", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "a", "--name", "Short"], testDir).code).toBe(0);
    expect(runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("A       | Short");
    expect(lines).toContain("LONGKEY | Long");
  });
});

test("project list does not retain a deleted project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["project", "create", "REMOVE", "--name", "Remove"], testDir);
    expect(
      runZinnWithConfirmation(["project", "delete", "REMOVE"], testDir).code,
    ).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KEEP");
    expect(result.stdout).not.toContain("REMOVE");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project view prints the project followed by the same active tasks as task list", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "VIEW", "--name", "Project view"], testDir);
    runZinn(
      [
        "task",
        "create",
        "VIEW",
        "--title",
        "Backlog task",
        "--description",
        "Backlog description",
        "--priority",
        "high",
      ],
      testDir,
    );
    runZinn(["task", "create", "VIEW", "--title", "TODO task"], testDir);
    runZinn(["task", "move", "VIEW-2", "TODO"], testDir);
    runZinn(["task", "create", "VIEW", "--title", "Archived task"], testDir);
    runZinn(["task", "archive", "VIEW-3"], testDir);

    const listedTasks = runZinn(["task", "list", "VIEW"], testDir);
    const viewedProject = runZinn(["project", "view", "view"], testDir);

    expect(viewedProject.code).toBe(0);
    expect(viewedProject.stderr).toBe("");
    expect(viewedProject.stdout).toBe(`VIEW | Project view\n\n${listedTasks.stdout}`);
    expect(viewedProject.stdout).not.toContain("Archived task");
  });
});

test("project view prints an empty project without inventing task output", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty project"], testDir);

    expect(runZinn(["project", "view", "EMPTY"], testDir).stdout).toBe(
      "EMPTY | Empty project\n",
    );
  });
});

test("project view JSON contains project identity and a flat active-task array", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "ready", "--color", "green"], testDir);
    runZinn(["project", "create", "VIEW", "--name", "Project view"], testDir);
    runZinn(
      [
        "task",
        "create",
        "VIEW",
        "--title",
        "Visible task",
        "--description",
        "Full description",
        "--priority",
        "urgent",
        "--label",
        "ready",
      ],
      testDir,
    );

    const viewedProject = runZinn(["project", "view", "VIEW", "--json"], testDir);

    expect(viewedProject.code).toBe(0);
    expect(JSON.parse(viewedProject.stdout)).toEqual({
      key: "VIEW",
      name: "Project view",
      description: null,
      tasks: [
        {
          key: "VIEW-1",
          status: "Active",
          column: "Backlog",
          title: "Visible task",
          description: "Full description",
          priority: "urgent",
          labels: ["ready"],
        },
      ],
    });
  });
});

test("project view validates its project key", () => {
  withIsolatedZinnDir((testDir) => {
    const missing = runZinn(["project", "view"], testDir);
    const extra = runZinn(["project", "view", "ONE", "TWO"], testDir);
    const unknown = runZinn(["project", "view", "unknown"], testDir);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Project key must be specified");
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("Only one project key can be specified");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Project with key "UNKNOWN" does not exist!');
  });
});

test("project create accepts an alphanumeric key in any casing and stores it uppercase", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "b2B", "--name", "Business"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("B2B | Business\n");
  });
});

test("project create rejects keys outside the alphanumeric contract", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidKey of ["2B", "APP-DEV", "APP_DEV", "ÅPP", ""]) {
      const result = runZinn(["project", "create", invalidKey, "--name", "Invalid"], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Project key must start with a letter and contain only letters and numbers",
      );
    }
  });
});

test("project create rejects blank or non-single-line names", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidName of ["", "   ", "first line\nsecond line", "name\u001b[31m"]) {
      const result = runZinn(["project", "create", "SAFE", "--name", invalidName], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Project name cannot be blank or contain line breaks or control characters");
    }
  });
});

// --- TASK

test("task create rejects an unknown project", () => {
  const result = runZinn(["task", "create", "NOPE", "--title", "orphan task"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Project with key "NOPE" does not exist`);
});

test("task create requires a project key and a title", () => {
  runZinn(["project", "create", "ARGS", "--name", "Args"]);

  expect(runZinn(["task", "create"]).stderr).toContain("A task needs to belong to a project");
  expect(runZinn(["task", "create", "ARGS"]).stderr).toContain("A task needs at least a title");
});

test("task create succeeds against an existing project", () => {
  runZinn(["project", "create", "TSK", "--name", "Tasks"]);

  const result = runZinn(["task", "create", "TSK", "--title", "first task"]);

  // The placement contract is asserted independently below.
  expect(result.code).toBe(0);
});

test("task create attaches the task to its project's first ordered column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "PLACE", "--name", "Placed"], testDir);
    runZinn(["project", "column", "create", "PLACE", "Later"], testDir);

    expect(runZinn(["task", "create", "PLACE", "--title", "placed task"], testDir).code).toBe(0);

    withTestDb(testDir, (db) => {
      const taskRow = db
        .query<
          { project_id: string; column_id: string },
          []
        >("SELECT project_id, column_id FROM task WHERE title = 'placed task'")
        .get();
      const firstColumn = db
        .query<
          { id: string; project_id: string; name: string },
          []
        >("SELECT id, project_id, name FROM project_column ORDER BY column_order LIMIT 1")
        .get();

      expect(taskRow).not.toBeNull();
      expect(firstColumn).not.toBeNull();
      expect(firstColumn?.name).toBe("Backlog");
      expect(taskRow?.column_id).toBe(firstColumn?.id);
      expect(taskRow?.project_id).toBe(firstColumn?.project_id);
    });
  });
});

test("task ordering starts independently in each column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "todo first"], testDir);

    withTestDb(testDir, (db) => {
      const todoColumn = db
        .query<{ id: string }, []>("SELECT id FROM project_column WHERE name = 'TODO'")
        .get();

      expect(todoColumn).not.toBeNull();
      db.run("UPDATE task SET column_id = ? WHERE title = 'todo first'", [todoColumn!.id]);
    });

    runZinn(["task", "create", "ALPHA", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "backlog second"], testDir);

    withTestDb(testDir, (db) => {
      const rows = db
        .query<{ title: string; task_order: string }, []>(
          "SELECT title, task_order FROM task ORDER BY title",
        )
        .all();

      expect(rows).toHaveLength(3);
      expect(rows[0]?.task_order).toBe(rows[2]?.task_order);
      expect(rows[1]!.task_order > rows[0]!.task_order).toBe(true);
    });
  });
});

test("a project without columns rejects task creation without consuming a task number", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTYCOL", "--name", "No columns"], testDir);
    withTestDb(testDir, (db) => db.run("DELETE FROM project_column"));

    const rejected = runZinn(["task", "create", "EMPTYCOL", "--title", "cannot place me"], testDir);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Project "EMPTYCOL" does not have any columns');

    runZinn(["project", "column", "create", "EMPTYCOL", "Inbox"], testDir);
    expect(runZinn(["task", "create", "EMPTYCOL", "--title", "first real task"], testDir).code).toBe(0);
    expect(runZinn(["task", "view", "EMPTYCOL-1"], testDir).stdout).toContain(
      "EMPTYCOL-1 | Inbox | first real task",
    );
  });
});

test("task list on an empty database exits cleanly without output", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list renders every project's tasks once and aligns unequal key widths", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "a", "--name", "Short"], testDir);
    runZinn(["project", "create", "LONGKEY", "--name", "Long"], testDir);
    runZinn(["task", "create", "A", "--title", "short task", "--description", "short description"], testDir);
    runZinn(["task", "create", "LONGKEY", "--title", "long task", "--description", "long description"], testDir);

    const result = runZinn(["task", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain(`A-1       | Backlog | - | short task | short description`);
    expect(lines).toContain(
      `LONGKEY-1 | Backlog | - | long task | long description`,
    );
  });
});

test("task list does not print a missing description as data", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    runZinn(["task", "create", "NONE", "--title", "title only"], testDir);

    const result = runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`NONE-1 | Backlog | - | title only`);
    expect(result.stdout).not.toContain("null");
  });
});

test("task list renders an 80-character single-line description preview", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "PREVIEW", "--name", "Description preview"], testDir);
    const description = `${"A".repeat(40)}\n\t${"B".repeat(50)}`;
    const expectedPreview = `${"A".repeat(40)} ${"B".repeat(38)}…`;

    runZinn(
      ["task", "create", "PREVIEW", "--title", "long description", "--description", description],
      testDir,
    );

    const listResult = runZinn(["task", "list", "PREVIEW"], testDir);
    const viewResult = runZinn(["task", "view", "PREVIEW-1"], testDir);

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toBe(
      `PREVIEW-1 | Backlog | - | long description | ${expectedPreview}\n`,
    );
    expect(expectedPreview.length).toBe(80);
    expect(viewResult.code).toBe(0);
    expect(viewResult.stdout).toBe(
      `PREVIEW-1 | Backlog | long description | ${description}\n`,
    );
  });
});

test("task list filters to the requested project regardless of key casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ALPHA", "--name", "Alpha"], testDir);
    runZinn(["project", "create", "BETA", "--name", "Beta"], testDir);
    runZinn(["task", "create", "ALPHA", "--title", "alpha task"], testDir);
    runZinn(["task", "create", "BETA", "--title", "beta task"], testDir);

    const result = runZinn(["task", "list", "aLpHa"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ALPHA-1 | Backlog | - | alpha task`);
    expect(result.stdout).not.toContain("beta task");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project-scoped task list aligns column names and follows board order", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "todo first"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "in progress"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "todo second"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "backlog second"], testDir);

    runZinn(["task", "move", "ORDER-1", "TODO"], testDir);
    runZinn(["task", "move", "ORDER-3", "In Progress"], testDir);
    runZinn(["task", "move", "ORDER-4", "TODO"], testDir);

    const result = runZinn(["task", "list", "ORDER"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "ORDER-2 | Backlog     | - | backlog first",
        "ORDER-5 | Backlog     | - | backlog second",
        "ORDER-1 | TODO        | - | todo first",
        "ORDER-4 | TODO        | - | todo second",
        "ORDER-3 | In Progress | - | in progress",
        "",
      ].join("\n"),
    );
  });
});

test("task list for an empty project does not leak another project's tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);
    runZinn(["project", "create", "BUSY", "--name", "Busy"], testDir);
    runZinn(["task", "create", "BUSY", "--title", "private task"], testDir);

    const result = runZinn(["task", "list", "EMPTY"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});

test("task list rejects an unknown project", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "list", "NOSUCH"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Project with key "NOSUCH" does not exist!`);
  });
});

test("task list and search filter by every repeated label", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    run("project", "create", "FILTER");
    run("label", "create", "CLI");
    run("label", "create", "Groom");
    run("task", "create", "FILTER", "--title", "Both labels", "--label", "CLI", "--label", "Groom");
    run("task", "create", "FILTER", "--title", "CLI only", "--label", "CLI");
    run("task", "create", "FILTER", "--title", "Groom only", "--label", "Groom");
    run("task", "archive", "FILTER-3");

    const listed = JSON.parse(
      run("task", "list", "FILTER", "--label", "cli", "--label", "GROOM", "--json").stdout,
    );
    expect(listed.map((entry: { key: string }) => entry.key)).toEqual(["FILTER-1"]);

    const searched = run(
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

    const archived = run("task", "list", "FILTER", "--archived", "--label", "groom");
    expect(archived.stdout).toContain("FILTER-3");
    expect(run("task", "list", "--label", "missing").stderr).toContain(
      'A label with name "missing" does not exist',
    );
    expect(run("task", "search", "labels", "--label", "missing").code).toBe(1);
  });
});

test("project-scoped task list aligns one- and two-digit task numbers", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "TEN", "--name", "Ten tasks"], testDir);
    for (let number = 1; number <= 10; number++) {
      runZinn(["task", "create", "TEN", "--title", `task ${number}`], testDir);
    }

    const result = runZinn(["task", "list", "TEN"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(10);
    expect(lines).toContain(`TEN-1  | Backlog | - | task 1`);
    expect(lines).toContain(`TEN-10 | Backlog | - | task 10`);
  });
});

test("task view resolves a case-insensitive key and prints its canonical form", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "VIEW", "--name", "Viewed"], testDir);
    runZinn(["task", "create", "VIEW", "--title", "visible task", "--description", "visible description"], testDir);

    const result = runZinn(["task", "view", "vIeW-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `VIEW-1 | Backlog | visible task | visible description\n`,
    );
  });
});

test("task view does not print a missing description as data", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NONE", "--name", "No description"], testDir);
    runZinn(["task", "create", "NONE", "--title", "title only"], testDir);

    const result = runZinn(["task", "view", "NONE-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`NONE-1 | Backlog | title only\n`);
  });
});

test("human task output omits empty descriptions while JSON returns null", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EMPTY", "--name", "Empty description"], testDir);

    const created = runZinn(
      ["task", "create", "EMPTY", "--title", "Empty description", "--description", ""],
      testDir,
    );
    expect(created.stdout).toBe(`EMPTY-1 | Backlog | Empty description\n`);

    expect(runZinn(["task", "list", "EMPTY"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(runZinn(["task", "search", "Empty", "EMPTY"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | - | Empty description\n`,
    );
    expect(runZinn(["task", "view", "EMPTY-1"], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | Empty description\n`,
    );

    runZinn(["task", "edit", "EMPTY-1", "--description", "Visible"], testDir);
    expect(runZinn(["task", "edit", "EMPTY-1", "--description", ""], testDir).stdout).toBe(
      `EMPTY-1 | Backlog | Empty description\n`,
    );

    expect(JSON.parse(runZinn(["task", "list", "EMPTY", "--json"], testDir).stdout)).toEqual([
      expect.objectContaining({ key: "EMPTY-1", description: null }),
    ]);
  });
});

test("task move, list and view color workflow column names only in a terminal, while JSON stays raw", async () => {
  await withIsolatedZinnDirAsync(async (testDir) => {
    runZinn(["project", "create", "COLOR", "--name", "Column colors"], testDir);
    runZinn(["task", "create", "COLOR", "--title", "waiting"], testDir);
    runZinn(["task", "create", "COLOR", "--title", "finished"], testDir);

    const moved = await runZinnInTerminal(["task", "move", "COLOR-2", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.output).toBe(`COLOR-2 | ${GREEN_DONE}\n`);

    expect((await runZinnInTerminal(["task", "list", "COLOR"], testDir)).output).toBe(
      [
        `COLOR-1 | ${GRAY_BACKLOG} | - | waiting`,
        `COLOR-2 | \x1b[32m${"Done".padEnd("Backlog".length)}\x1b[39m | - | finished`,
        "",
      ].join("\n"),
    );
    expect((await runZinnInTerminal(["task", "view", "COLOR-1"], testDir)).output).toContain(
      GRAY_BACKLOG,
    );
    expect((await runZinnInTerminal(["task", "view", "COLOR-2"], testDir)).output).toContain(
      GREEN_DONE,
    );

    // Piped output keeps the same layout without color codes.
    expect(runZinn(["task", "list", "COLOR"], testDir).stdout).toBe(
      ["COLOR-1 | Backlog | - | waiting", "COLOR-2 | Done    | - | finished", ""].join("\n"),
    );
    expect(runZinn(["task", "view", "COLOR-2"], testDir).stdout).toBe("COLOR-2 | Done | finished\n");
    expect(runZinn(["task", "move", "COLOR-2", "Done"], testDir).stdout).toBe("COLOR-2 | Done\n");

    const listedJson = runZinn(["task", "list", "COLOR", "--json"], testDir).stdout;
    expect(listedJson).not.toContain("\x1b");
    expect(JSON.parse(listedJson).map((task: { column: string }) => task.column)).toEqual([
      "Backlog",
      "Done",
    ]);
  });
});

test("task view requires a task key", () => {
  withIsolatedZinnDir((testDir) => {
    const result = runZinn(["task", "view"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Task key must be specified");
  });
});

test("task view rejects malformed task keys with an actionable error", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidKey of ["VIEW", "VIEW-", "VIEW-one", "VIEW-1-extra", "-1"]) {
      const result = runZinn(["task", "view", invalidKey], testDir);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Invalid task key "${invalidKey}"`);
      expect(result.stderr).toContain("Expected format PROJECT-1");
    }
  });
});

test("task view distinguishes an unknown project from an unknown task number", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KNOWN", "--name", "Known"], testDir);

    const unknownProject = runZinn(["task", "view", "NOPE-1"], testDir);
    const unknownTask = runZinn(["task", "view", "KNOWN-99"], testDir);

    expect(unknownProject.code).toBe(1);
    expect(unknownProject.stderr).toContain(`Project with key "NOPE" does not exist!`);
    expect(unknownTask.code).toBe(1);
    expect(unknownTask.stderr).toContain(`Task "KNOWN-99" does not exist!`);
  });
});

test("task and comment key numbers are capped at 15 digits", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "CAP", "--name", "Cap"], testDir);
    runZinn(["task", "create", "CAP", "--title", "Only task"], testDir);

    const tooManyDigits = "9".repeat(20);
    const fifteenDigits = "9".repeat(15);

    // 16+ digits: rejected as a malformed key, never rounded and looked up.
    const invalidTask = runZinn(["task", "view", `CAP-${tooManyDigits}`], testDir);
    expect(invalidTask.stderr).toContain(`Invalid task key "CAP-${tooManyDigits}"`);

    const invalidComment = runZinn(
      ["task", "comment", "edit", `CAP-1#${tooManyDigits}`, "--text", "x"],
      testDir,
    );
    expect(invalidComment.stderr).toContain(`Invalid comment key "CAP-1#${tooManyDigits}"`);

    // Exactly 15 digits: still a well-formed key (an exact JS integer), just not found.
    const missingTask = runZinn(["task", "view", `CAP-${fifteenDigits}`], testDir);
    expect(missingTask.stderr).toContain(`Task "CAP-${fifteenDigits}" does not exist!`);

    const missingComment = runZinn(
      ["task", "comment", "edit", `CAP-1#${fifteenDigits}`, "--text", "x"],
      testDir,
    );
    expect(missingComment.stderr).toContain(`Comment "CAP-1#${fifteenDigits}" does not exist`);
  });
});

test("task comments can be created, listed, edited, viewed, and deleted", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NOTE"], testDir);
    runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const first = runZinn(
      ["task", "comment", "create", "NOTE-1", "--text", "First comment"],
      testDir,
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("NOTE-1#1 | First comment\n");

    const second = JSON.parse(
      runZinn(
        ["task", "comment", "create", "note-1", "--text", "Second comment", "--json"],
        testDir,
      ).stdout,
    );
    expect(second).toEqual({
      key: "NOTE-1#2",
      text: "Second comment",
      created_at: second.created_at,
      updated_at: second.updated_at,
    });
    expect(second.created_at).toBeNumber();
    expect(second.updated_at).toBe(second.created_at);

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [
        Date.UTC(2026, 8, 24, 9, 5),
      ]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [
        Date.UTC(2026, 8, 25, 17, 42),
      ]);
    });

    expect(
      runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      }).stdout,
    ).toBe(
      "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment\n",
    );

    expect(
      runZinn(
        ["task", "comment", "edit", second.key, "--text", "Edited second"],
        testDir,
      ).stdout,
    ).toBe("NOTE-1#2 | Edited second\n");

    const viewed = runZinn(["task", "view", "NOTE-1"], testDir, {
      TZ: "Europe/Berlin",
    });
    expect(viewed.stdout).toContain(
      "\n\nComments:\n" +
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Edited second\n",
    );

    const viewedJson = JSON.parse(
      runZinn(["task", "view", "NOTE-1", "--json"], testDir).stdout,
    );
    expect(viewedJson.comments.map((entry: { key: string }) => entry.key)).toEqual([
      "NOTE-1#1",
      "NOTE-1#2",
    ]);

    const deleted = runZinnWithConfirmation(
      ["task", "comment", "delete", "NOTE-1#2"],
      testDir,
    );
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("Deleted NOTE-1#2");

    expect(
      runZinn(["task", "comment", "create", "NOTE-1", "--text", "Third comment"], testDir)
        .stdout,
    ).toBe("NOTE-1#3 | Third comment\n");

    expect(
      runZinn(["task", "comment", "create", "NOTE-1", "--text", "Line one\nLine two"], testDir)
        .stdout,
    ).toBe("NOTE-1#4 | Line one\n           Line two\n");

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 4", [
        Date.UTC(2026, 8, 25, 18, 7),
      ]);
    });

    const multilinePrefix = "NOTE-1#4 | 2026-09-25 20:07 +02:00 | ";
    expect(
      runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      }).stdout,
    ).toContain(`${multilinePrefix}Line one\n${" ".repeat(multilinePrefix.length)}Line two\n`);
  });
});

test("task comment commands validate their inputs without partial writes", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "NOTE"], testDir);
    runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "comment", "create", "NOTE-1"], "Comment text must be specified"],
      [["task", "comment", "create", "NOTE-1", "--text", "   "], "cannot be blank"],
      [
        ["task", "comment", "create", "NOTE-1", "--text", "one", "--text", "two"],
        "only be specified once",
      ],
      [["task", "comment", "list"], "Exactly one task key is required"],
      [["task", "comment", "edit", "NOTE-1#1"], "Comment text must be specified"],
      [
        ["task", "comment", "edit", "019dbfc3-f513-7000-8000-000000000000", "--text", "No"],
        "Invalid comment key",
      ],
      [["task", "comment", "delete"], "Exactly one comment key is required"],
    ];

    for (const [args, message] of cases) {
      const result = runZinn(args, testDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    }

    expect(runZinn(["task", "comment", "list", "NOTE-1"], testDir).stdout).toBe("");
  });
});

test("task move requires a task key and target column", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["task", "move"], testDir).stderr).toContain("Task key must be specified");
    expect(runZinn(["task", "move", "MOVE-1"], testDir).stderr).toContain(
      "Target column must be specified",
    );
  });
});

test("task move help documents destination placement", () => {
  const longHelp = runZinn(["task", "move", "--help"]);
  const shortHelp = runZinn(["task", "move", "-h"]);

  expect(longHelp.code).toBe(0);
  expect(longHelp.stderr).toBe("");
  expect(longHelp.stdout).toContain("Usage: zinn task move <task-key>... <target-column>");
  expect(longHelp.stdout).toContain(
    "Moving a task to a different column lists it last in that column,",
  );
  expect(longHelp.stdout).toContain(
    "Giving a task's current column as the target will not do anything, and a note says so.",
  );
  expect(longHelp.stdout).toContain(
    "Archived tasks must be unarchived before they can be moved.",
  );
  expect(shortHelp.code).toBe(0);
  expect(shortHelp.stdout).toBe(longHelp.stdout);
});

test("task move rejects a column outside the task's project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORIGIN", "--name", "Origin"], testDir);
    runZinn(["project", "create", "OTHER", "--name", "Other"], testDir);
    runZinn(["project", "column", "create", "OTHER", "External"], testDir);
    runZinn(["task", "create", "ORIGIN", "--title", "stationary task"], testDir);

    const result = runZinn(["task", "move", "ORIGIN-1", "External"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Origin does not have a column named "External"`,
    );
    expect(runZinn(["task", "view", "ORIGIN-1"], testDir).stdout).toContain(
      `ORIGIN-1 | Backlog | stationary task`,
    );
  });
});

test("task move appends the task to the destination column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MOVE", "--name", "Movable"], testDir);
    runZinn(["task", "create", "MOVE", "--title", "first task"], testDir);
    runZinn(["task", "create", "MOVE", "--title", "second task"], testDir);

    expect(runZinn(["task", "move", "MOVE-1", "In Progress"], testDir).code).toBe(0);
    expect(runZinn(["task", "move", "MOVE-2", "In Progress"], testDir).code).toBe(0);

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

test("task move to the current column is a no-op", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "STILL", "--name", "Still"], testDir);
    runZinn(["task", "create", "STILL", "--title", "still task"], testDir);

    const before = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    const result = runZinn(["task", "move", "STILL-1", "Backlog"], testDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`STILL-1 | Backlog\n`);

    const after = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    expect(after).toEqual(before);
  });
});

test("task move takes several tasks, appends them in argument order, and notes no-ops", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MANY"], testDir);
    for (const title of ["one", "two", "three"]) {
      runZinn(["task", "create", "MANY", "--title", title], testDir);
    }
    runZinn(["task", "move", "MANY-1", "In Progress"], testDir);

    const result = runZinn(["task", "move", "MANY-3", "MANY-1", "MANY-2", "In Progress"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("MANY-3 | In Progress\nMANY-1 | In Progress\nMANY-2 | In Progress\n");
    expect(result.stderr).toBe("MANY-1 was already in the In Progress column\n");
    expect(runZinn(["task", "list", "MANY"], testDir).stdout).toMatch(
      /^MANY-1[^\n]*\nMANY-3[^\n]*\nMANY-2[^\n]*\n$/,
    );
  });
});

test("task archive and unarchive take several tasks and note no-ops", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SHELF"], testDir);
    for (const title of ["one", "two", "three"]) {
      runZinn(["task", "create", "SHELF", "--title", title], testDir);
    }
    runZinn(["task", "archive", "SHELF-2"], testDir);

    const archived = runZinn(["task", "archive", "SHELF-1", "SHELF-2"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "SHELF-1 | Archived | Backlog | one\nSHELF-2 | Archived | Backlog | two\n",
    );
    expect(archived.stderr).toBe("SHELF-2 was already archived\n");

    const unarchived = runZinn(["task", "unarchive", "SHELF-2", "SHELF-3", "SHELF-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stderr).toBe("SHELF-3 was already active\n");
    expect(runZinn(["task", "list", "SHELF"], testDir).stdout).toMatch(
      /^SHELF-3[^\n]*\nSHELF-2[^\n]*\nSHELF-1[^\n]*\n$/,
    );
  });
});

test("task move, archive and unarchive change nothing when any task fails", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ATOM"], testDir);
    runZinn(["task", "create", "ATOM", "--title", "active"], testDir);
    runZinn(["task", "create", "ATOM", "--title", "archived"], testDir);
    runZinn(["task", "archive", "ATOM-2"], testDir);
    const before = runZinn(["task", "list", "ATOM", "--all", "--json"], testDir).stdout;

    const move = runZinn(["task", "move", "ATOM-1", "ATOM-2", "Done"], testDir);
    expect(move.code).toBe(1);
    expect(move.stderr).toContain('Archived task "ATOM-2" cannot be moved');

    const archive = runZinn(["task", "archive", "ATOM-1", "ATOM-404"], testDir);
    expect(archive.code).toBe(1);
    expect(archive.stderr).toContain('Task "ATOM-404" does not exist');

    const unarchive = runZinn(["task", "unarchive", "ATOM-2", "nope"], testDir);
    expect(unarchive.code).toBe(1);
    expect(unarchive.stderr).toContain('Invalid task key "nope"');

    expect(runZinn(["task", "list", "ATOM", "--all", "--json"], testDir).stdout).toBe(before);
  });
});

test("task move, archive and unarchive print an object for one task and an array for several with --json", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SHAPE"], testDir);
    runZinn(["task", "create", "SHAPE", "--title", "one"], testDir);
    runZinn(["task", "create", "SHAPE", "--title", "two"], testDir);

    const moveOne = JSON.parse(runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir).stdout);
    expect(moveOne).toMatchObject({ key: "SHAPE-1", column: "Done" });

    const archiveMany = JSON.parse(
      runZinn(["task", "archive", "SHAPE-1", "SHAPE-2", "--json"], testDir).stdout,
    );
    expect(archiveMany).toMatchObject([
      { key: "SHAPE-1", status: "Archived" },
      { key: "SHAPE-2", status: "Archived" },
    ]);

    const unarchiveOne = JSON.parse(
      runZinn(["task", "unarchive", "SHAPE-2", "--json"], testDir).stdout,
    );
    expect(unarchiveOne).toMatchObject({ key: "SHAPE-2", status: "Active" });
  });
});

test("task move prints only the key and new column, while --json returns the full task", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["label", "create", "urgent"], testDir);
    runZinn(["project", "create", "BRIEF"], testDir);
    runZinn(
      ["task", "create", "BRIEF", "--title", "Detailed task", "--description", "Hidden from move output", "--priority", "high", "--label", "urgent"],
      testDir,
    );

    const moved = runZinn(["task", "move", "BRIEF-1", "In Progress"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe("BRIEF-1 | In Progress\n");

    const movedJson = runZinn(["task", "move", "BRIEF-1", "Review", "--json"], testDir);
    expect(movedJson.code).toBe(0);
    expect(JSON.parse(movedJson.stdout)).toEqual({
      key: "BRIEF-1",
      status: "Active",
      column: "Review",
      title: "Detailed task",
      description: "Hidden from move output",
      priority: "high",
      labels: ["urgent"],
    });
  });
});

test("task move rejects archived tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCHMOVE", "--name", "Archived move"], testDir);
    runZinn(["task", "create", "ARCHMOVE", "--title", "archived task"], testDir);
    runZinn(["task", "archive", "ARCHMOVE-1"], testDir);

    const before = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string; updated_at: number }, []>(
          "SELECT column_id, task_order, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );

    const result = runZinn(
      ["task", "move", "ARCHMOVE-1", "In Progress"],
      testDir,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Archived task "ARCHMOVE-1" cannot be moved');

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

test("task order moves a task one position up or down within its column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ORDER", "--name", "Ordered"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "first task"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "second task"], testDir);
    runZinn(["task", "create", "ORDER", "--title", "third task"], testDir);

    expect(runZinn(["task", "order", "ORDER-2", "up"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ORDER"], testDir).stdout).toMatch(
      /ORDER-2[^\n]*\nORDER-1[^\n]*\nORDER-3/,
    );

    expect(runZinn(["task", "order", "ORDER-2", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ORDER"], testDir).stdout).toMatch(
      /ORDER-1[^\n]*\nORDER-2[^\n]*\nORDER-3/,
    );
  });
});

test("task order moves a task to the top or bottom of its column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "EDGES", "--name", "Edges"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "first task"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "second task"], testDir);
    runZinn(["task", "create", "EDGES", "--title", "third task"], testDir);

    expect(runZinn(["task", "order", "EDGES-3", "top"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "EDGES"], testDir).stdout).toMatch(
      /EDGES-3[^\n]*\nEDGES-1[^\n]*\nEDGES-2/,
    );

    expect(runZinn(["task", "order", "EDGES-3", "bottom"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "EDGES"], testDir).stdout).toMatch(
      /EDGES-1[^\n]*\nEDGES-2[^\n]*\nEDGES-3/,
    );
  });
});

test("task order places a task immediately before or after its target", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ANCHOR", "--name", "Anchored"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "first task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "second task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "third task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "fourth task"], testDir);
    runZinn(["task", "create", "ANCHOR", "--title", "fifth task"], testDir);

    expect(runZinn(["task", "order", "ANCHOR-4", "before", "ANCHOR-2"], testDir).code).toBe(
      0,
    );
    expect(runZinn(["task", "list", "ANCHOR"], testDir).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-4[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-5/,
    );

    expect(runZinn(["task", "order", "ANCHOR-4", "after", "ANCHOR-3"], testDir).code).toBe(
      0,
    );
    expect(runZinn(["task", "list", "ANCHOR"], testDir).stdout).toMatch(
      /ANCHOR-1[^\n]*\nANCHOR-2[^\n]*\nANCHOR-3[^\n]*\nANCHOR-4[^\n]*\nANCHOR-5/,
    );
  });
});

test("task order requires a task key and an ordering instruction", () => {
  const missingTask = runZinn(["task", "order"]);
  expect(missingTask.code).toBe(1);
  expect(missingTask.stderr).toContain("Task key must be specified");

  const missingInstruction = runZinn(["task", "order", "ORDER-1"]);
  expect(missingInstruction.code).toBe(1);
  expect(missingInstruction.stderr).toContain("Order direction must be specified");
});

test("task order validates direction and target arguments", () => {
  const unknownDirection = runZinn(["task", "order", "ORDER-1", "sideways"]);
  expect(unknownDirection.code).toBe(1);
  expect(unknownDirection.stderr).toContain('Unknown order direction "sideways"');

  const missingTarget = runZinn(["task", "order", "ORDER-1", "before"]);
  expect(missingTarget.code).toBe(1);
  expect(missingTarget.stderr).toContain('Target task must be specified for "before"');

  const unexpectedTarget = runZinn(["task", "order", "ORDER-1", "top", "ORDER-2"]);
  expect(unexpectedTarget.code).toBe(1);
  expect(unexpectedTarget.stderr).toContain('Order direction "top" does not accept a target task');
});

test("task order help documents its own command", () => {
  const result = runZinn(["task", "order", "--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: zinn task order");
  expect(result.stdout).toContain("top");
  expect(result.stdout).toContain("up");
  expect(result.stdout).toContain("down");
  expect(result.stdout).toContain("bottom");
  expect(result.stdout).toContain("before");
  expect(result.stdout).toContain("after");
});

test("task order does not cross a column boundary", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "BOUND", "--name", "Bounded"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "backlog first"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "backlog last"], testDir);
    runZinn(["task", "create", "BOUND", "--title", "progress first"], testDir);
    runZinn(["task", "move", "BOUND-3", "In Progress"], testDir);

    withTestDb(testDir, (db) => {
      db.run("UPDATE task SET updated_at = 1 WHERE number IN (2, 3)");
    });

    expect(runZinn(["task", "order", "BOUND-2", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "order", "BOUND-3", "up"], testDir).code).toBe(0);

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

test("task order rejects an unknown target task", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "TARGET", "--name", "Targeted"], testDir);
    runZinn(["task", "create", "TARGET", "--title", "existing task"], testDir);

    const result = runZinn(["task", "order", "TARGET-1", "before", "TARGET-99"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Task "TARGET-99" does not exist!');
  });
});

test("task order rejects a target in another column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SCOPE", "--name", "Scoped"], testDir);
    runZinn(["task", "create", "SCOPE", "--title", "backlog task"], testDir);
    runZinn(["task", "create", "SCOPE", "--title", "progress task"], testDir);
    runZinn(["task", "move", "SCOPE-2", "In Progress"], testDir);

    const result = runZinn(["task", "order", "SCOPE-1", "before", "SCOPE-2"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same column");
  });
});

test("task order targeting itself is a no-op", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "UNCHANGED", "--name", "Unchanged"], testDir);
    runZinn(["task", "create", "UNCHANGED", "--title", "stationary task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));

    expect(
      runZinn(["task", "order", "UNCHANGED-1", "before", "UNCHANGED-1"], testDir).code,
    ).toBe(0);

    const row = withTestDb(testDir, (db) =>
      db
        .query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1")
        .get(),
    );

    expect(row?.updated_at).toBe(1);
  });
});

test("task order leaves already-satisfied placements unchanged", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "SATISFIED", "--name", "Satisfied"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "first task"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "second task"], testDir);
    runZinn(["task", "create", "SATISFIED", "--title", "third task"], testDir);

    withTestDb(testDir, (db) => db.run("UPDATE task SET updated_at = 1"));

    expect(runZinn(["task", "order", "SATISFIED-1", "top"], testDir).code).toBe(0);
    expect(runZinn(["task", "order", "SATISFIED-3", "bottom"], testDir).code).toBe(0);
    expect(
      runZinn(["task", "order", "SATISFIED-2", "before", "SATISFIED-3"], testDir).code,
    ).toBe(0);
    expect(
      runZinn(["task", "order", "SATISFIED-2", "after", "SATISFIED-1"], testDir).code,
    ).toBe(0);

    const timestamps = withTestDb(testDir, (db) =>
      db.query<{ updated_at: number }, []>("SELECT updated_at FROM task ORDER BY number").all(),
    );
    expect(timestamps).toEqual([{ updated_at: 1 }, { updated_at: 1 }, { updated_at: 1 }]);
  });
});

test("task order rejects a target in another project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "FIRST", "--name", "First"], testDir);
    runZinn(["project", "create", "SECOND", "--name", "Second"], testDir);
    runZinn(["task", "create", "FIRST", "--title", "first project task"], testDir);
    runZinn(["task", "create", "SECOND", "--title", "second project task"], testDir);

    const result = runZinn(
      ["task", "order", "FIRST-1", "before", "SECOND-1"],
      testDir,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same project");
  });
});

test("task order rejects archived source and target tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCHORDER", "--name", "Archived order"], testDir);
    runZinn(["task", "create", "ARCHORDER", "--title", "active task"], testDir);
    runZinn(["task", "create", "ARCHORDER", "--title", "archived task"], testDir);
    runZinn(["task", "archive", "ARCHORDER-2"], testDir);

    const archivedSource = runZinn(["task", "order", "ARCHORDER-2", "top"], testDir);
    expect(archivedSource.code).toBe(1);
    expect(archivedSource.stderr).toContain("cannot be reordered");

    const archivedTarget = runZinn(
      ["task", "order", "ARCHORDER-1", "before", "ARCHORDER-2"],
      testDir,
    );
    expect(archivedTarget.code).toBe(1);
    expect(archivedTarget.stderr).toContain("cannot be an ordering target");
  });
});

test("task order uses visible active neighbours", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "VISIBLE", "--name", "Visible"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "first task"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "archived task"], testDir);
    runZinn(["task", "create", "VISIBLE", "--title", "third task"], testDir);
    runZinn(["task", "archive", "VISIBLE-2"], testDir);

    expect(runZinn(["task", "order", "VISIBLE-1", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "VISIBLE"], testDir).stdout).toMatch(
      /VISIBLE-3[^\n]*\nVISIBLE-1/,
    );
  });
});

test("task archive hides a task from active lists without deleting it", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "ARCH", "--name", "Archive"], testDir);
    runZinn(["task", "create", "ARCH", "--title", "kept task", "--description", "kept description"], testDir);
    runZinn(["task", "move", "ARCH-1", "In Progress"], testDir);

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

    expect(runZinn(["task", "archive", "aRcH-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "ARCH"], testDir).stdout).toBe("");
    expect(runZinn(["task", "list", "ARCH", "--archived"], testDir).stdout).toContain(
      "ARCH-1 | In Progress | - | kept task | kept description",
    );
    expect(runZinn(["task", "list", "--all", "ARCH"], testDir).stdout).toContain("kept task");
    expect(runZinn(["task", "view", "ARCH-1"], testDir).stdout).toContain("kept task");

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

test("task list --all identifies active and archived tasks in a status column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "MIXED", "--name", "Mixed archive"], testDir);
    runZinn(["task", "create", "MIXED", "--title", "archived task"], testDir);
    runZinn(["task", "create", "MIXED", "--title", "active task"], testDir);
    runZinn(["task", "archive", "MIXED-1"], testDir);

    expect(runZinn(["task", "list", "MIXED"], testDir).stdout).toBe(
      `MIXED-2 | Backlog | - | active task\n`,
    );
    expect(runZinn(["task", "list", "MIXED", "--archived"], testDir).stdout).toBe(
      `MIXED-1 | Backlog | - | archived task\n`,
    );
    expect(runZinn(["task", "list", "MIXED", "--all"], testDir).stdout).toBe(
      [
        `MIXED-2 | Active   | Backlog | - | active task`,
        `MIXED-1 | Archived | Backlog | - | archived task`,
        "",
      ].join("\n"),
    );
  });
});

test("task unarchive appends the task after active tasks in its previous column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "RESTOREORDER", "--name", "Restore order"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "first task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "second task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "--title", "third task"], testDir);
    runZinn(["task", "archive", "RESTOREORDER-1"], testDir);

    const archived = withTestDb(testDir, (db) =>
      db
        .query<{ column_id: string; task_order: string }, []>(
          "SELECT column_id, task_order FROM task WHERE number = 1",
        )
        .get(),
    )!;

    expect(runZinn(["task", "unarchive", "RESTOREORDER-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "RESTOREORDER"], testDir).stdout).toMatch(
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

test("task unarchive help documents restored placement", () => {
  const result = runZinn(["task", "unarchive", "--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "Unarchive tasks at the bottom of their previous columns, in the order given.",
  );
});

test("task archive is idempotent and unarchive restores active listing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "RESTORE", "--name", "Restore"], testDir);
    runZinn(["task", "create", "RESTORE", "--title", "restorable task"], testDir);
    runZinn(["task", "archive", "RESTORE-1"], testDir);

    withTestDb(testDir, (db) =>
      db.run("UPDATE task SET archived_at = 123, updated_at = 123 WHERE number = 1"),
    );
    expect(runZinn(["task", "archive", "RESTORE-1"], testDir).code).toBe(0);

    const stillArchived = withTestDb(testDir, (db) =>
      db
        .query<{ archived_at: number; updated_at: number }, []>(
          "SELECT archived_at, updated_at FROM task WHERE number = 1",
        )
        .get(),
    );
    expect(stillArchived).toEqual({ archived_at: 123, updated_at: 123 });

    expect(runZinn(["task", "unarchive", "RESTORE-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "RESTORE"], testDir).stdout).toContain("restorable task");
    expect(runZinn(["task", "list", "RESTORE", "--archived"], testDir).stdout).toBe("");

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

    expect(runZinn(["task", "unarchive", "RESTORE-1"], testDir).code).toBe(0);

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

test("task archive and unarchive require a valid existing task key", () => {
  expect(runZinn(["task", "archive"]).stderr).toContain("Task key must be specified");
  expect(runZinn(["task", "unarchive"]).stderr).toContain("Task key must be specified");
  expect(runZinn(["task", "archive", "INVALID"]).stderr).toContain(
    'Invalid task key "INVALID"',
  );
  expect(runZinn(["task", "unarchive", "NOPE-1"]).stderr).toContain(
    'Project with key "NOPE" does not exist!',
  );
});

test("project list shows every established project", () => {
  runZinn(["project", "create", "LIST", "--name", "Listed"]);

  const result = runZinn(["project", "list"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("LIST");
});

test("task delete removes the task but not its project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "doomed task"], testDir);

    expect(runZinnWithConfirmation(["task", "delete", "KEEP-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).not.toContain("doomed task");
    expect(runZinn(["project", "list"], testDir).stdout).toContain("KEEP");
  });
});

test("task delete keeps the task when confirmation is declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "KEEP", "--name", "Keep"], testDir);
    runZinn(["task", "create", "KEEP", "--title", "surviving task"], testDir);

    expect(runZinn(["task", "delete", "KEEP-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).toContain("surviving task");
  });
});

test("task delete requires a valid existing task key", () => {
  expect(runZinn(["task", "delete"]).stderr).toContain("Task key must be specified");
  expect(runZinn(["task", "delete", "INVALID"]).stderr).toContain(
    'Invalid task key "INVALID"',
  );
});

test("task edit preserves omitted fields and identity, and accepts empty descriptions", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../core/src/types").Task, []>("SELECT * FROM task").get()!);
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    const before = read();
    expect(runZinn(["task", "edit", "edit-1", "--title", "New title"], dir).code).toBe(0);
    const after = read();
    expect(after).toEqual({ ...before, title: "New title", updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(1);
    expect(runZinn(["task", "edit", "EDIT-1", "--description", ""], dir).code).toBe(0);
    expect(read().description).toBeNull();
    expect(read().title).toBe("New title");
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    expect(runZinn(["task", "edit", "EDIT-1", "--title", "New title", "--description", ""], dir).code).toBe(0);
    expect(read().updated_at).toBe(1);
    expect(runZinn(["task", "edit", "--description=Changed", "EDIT-1", "--title=--example"], dir).code).toBe(0);
    expect(read()).toMatchObject({ title: "--example", description: "Changed" });
  });
});

test("task edit rejects invalid requests without partial writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const cases: Array<[string[], string]> = [
      [[], "Task key must be specified"],
      [["EDIT-1"], "Provide at least one edit flag"],
      [["EDIT-1", "--title"], "argument missing"],
      [["EDIT-1", "--description"], "argument missing"],
      [["EDIT-1", "--unknown", "text"], "Unknown option"],
      [["EDIT-1", "extra", "--title", "text"], "Only one task key"],
      [["EDIT-1", "--title", "one", "--title", "two"], "only be specified once"],
      [["EDIT-1", "--title", ""], "Task title cannot be blank"],
      [["EDIT-1", "--title", "   "], "Task title cannot be blank"],
      [["EDIT-1", "--title", "", "--description", "Changed"], "Task title cannot be blank"],
      [["INVALID", "--title", "text"], "Invalid task key"],
      [["EDIT-99", "--title", "text"], "does not exist"],
    ];
    for (const [args, message] of cases) {
      const result = runZinn(["task", "edit", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
    }
    expect(runZinn(["task", "view", "EDIT-1"], dir).stdout).toContain("Original | Description");
  });
});

test("task edit preserves archive state and documents its flags", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Original"], dir);
    runZinn(["task", "archive", "EDIT-1"], dir);
    expect(runZinn(["task", "edit", "EDIT-1", "--title", "Archived edit"], dir).code).toBe(0);
    expect(runZinn(["task", "list", "EDIT"], dir).stdout).toBe("");
    expect(runZinn(["task", "list", "EDIT", "--archived"], dir).stdout).toContain("Archived edit");
  });
  const help = runZinn(["task", "edit", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--description ""');
});

test("project and column mutations print the affected entity", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "life", "--name", "Responsive"], testDir).stdout).toBe(
      "LIFE | Responsive\n",
    );
    expect(
      runZinn(["project", "column", "create", "life", "Waiting"], testDir).stdout,
    ).toBe("LIFE | Waiting\n");
    expect(runZinnWithConfirmation(["project", "delete", "life"], testDir).stdout).toContain(
      "Deleted LIFE | Responsive\n",
    );
  });
});

test("task mutations print the resulting entity", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "LIFE", "--name", "Responsive"], testDir);

    expect(runZinn(["task", "create", "LIFE", "--title", "First", "--description", "Description"], testDir).stdout).toBe(
      `LIFE-1 | Backlog | First | Description\n`,
    );
    runZinn(["task", "create", "LIFE", "--title", "Second"], testDir);
    expect(
      runZinn(["task", "edit", "life-1", "--title", "Updated"], testDir).stdout,
    ).toBe(`LIFE-1 | Backlog | Updated | Description\n`);
    expect(runZinn(["task", "move", "LIFE-1", "TODO"], testDir).stdout).toBe("LIFE-1 | TODO\n");
    runZinn(["task", "move", "LIFE-2", "TODO"], testDir);
    expect(runZinn(["task", "order", "LIFE-2", "top"], testDir).stdout).toBe(
      "LIFE-2 | TODO | Second\n",
    );
    expect(runZinn(["task", "archive", "LIFE-1"], testDir).stdout).toBe(
      "LIFE-1 | Archived | TODO | Updated | Description\n",
    );
    expect(runZinn(["task", "unarchive", "LIFE-1"], testDir).stdout).toBe(
      "LIFE-1 | Active | TODO | Updated | Description\n",
    );
    expect(runZinnWithConfirmation(["task", "delete", "LIFE-1"], testDir).stdout).toContain(
      "Deleted LIFE-1 | TODO | Updated | Description",
    );
    expect(runZinn(["task", "delete", "LIFE-2"], testDir).stdout).toContain(
      "Deletion cancelled for LIFE-2 | TODO | Second",
    );
  });
});

// ? Empty strings pass the routers' `== null` guards; core's validation rejects them.
test("empty-string arguments are rejected", () => {
  runZinn(["project", "create", "EMPTY", "--name", "Empty"]);

  const blankTitle = runZinn(["task", "create", "EMPTY", "--title", ""]);
  expect(blankTitle.code).toBe(1);
  expect(blankTitle.stderr).toContain("Task title cannot be blank");

  const blankProject = runZinn(["project", "create", "", "--name", ""]);
  expect(blankProject.code).toBe(1);
  expect(blankProject.stderr).toContain("Project key must start with a letter");
});

// --- TASK SEARCH

test("task search prints matches in task list rows and JSON shape", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    run("project", "create", "FIND");
    run("task", "create", "FIND", "--title", "Refine the numbers", "--description", "Quarterly quota", "--priority", "high");
    run("task", "create", "FIND", "--title", "Unrelated");
    run("task", "comment", "create", "FIND-2", "--text", "Blocked on refinement tools");

    const result = run("task", "search", "REFIN");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `FIND-1 | Backlog | H | Refine the numbers | Quarterly quota`,
        `FIND-2 | Backlog | - | Unrelated`,
        "",
      ].join("\n"),
    );

    const listed = JSON.parse(run("task", "list", "FIND", "--json").stdout);
    const searched = JSON.parse(run("task", "search", "refine quota", "--json").stdout);
    expect(searched).toEqual([listed[0]]);
  });
});

test("task search with no matches exits zero without output", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EMPTY"], dir);
    runZinn(["task", "create", "EMPTY", "--title", "Something"], dir);

    expect(runZinn(["task", "search", "nothing"], dir)).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(runZinn(["task", "search", "nothing", "--json"], dir)).toEqual({
      stdout: "[]\n",
      stderr: "",
      code: 0,
    });
  });
});

test("task search treats FTS syntax as text and accepts a leading dash after --", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "SYN"], dir);
    runZinn(["task", "create", "SYN", "--title", "Fix sign-in (again)", "--description", "AND NOT"], dir);

    for (const query of ["-", '"', ":", "(", "AND", "NOT", "*", 'sign-in "', "NEAR(a b)"]) {
      const result = runZinn(["task", "search", "--", query], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }

    expect(runZinn(["task", "search", "--", "-sign"], dir).stdout).toContain("SYN-1");
    expect(runZinn(["task", "search", "(again) and not"], dir).stdout).toContain("SYN-1");
  });
});

test("task search treats --json and --help after -- as literal query text, not router flags", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "ESC"], dir);
    runZinn(["task", "create", "ESC", "--title", "Something"], dir);

    // Neither literal query matches any task; JSON mode would print "[]\n"
    // and a help request would print usage text, so empty output on both
    // stdout and stderr confirms "--json"/"--help" were searched for, not acted on.
    expect(runZinn(["task", "search", "--", "--json"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(runZinn(["task", "search", "--", "--help"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
  });
});

test("task search pins an exact task key before text matches", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "PIN"], dir);
    runZinn(["task", "create", "PIN", "--title", "Mentions pin-2 first"], dir);
    runZinn(["task", "create", "PIN", "--title", "The pinned task"], dir);

    const keys = JSON.parse(runZinn(["task", "search", "pin-2", "--json"], dir).stdout).map(
      (entry: { key: string }) => entry.key,
    );
    expect(keys).toEqual(["PIN-2", "PIN-1"]);
  });
});

test("task search hides archived matches with a stderr hint and filters by project and limit", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    run("project", "create", "ONE");
    run("project", "create", "TWO");
    run("task", "create", "ONE", "--title", "Widget active");
    run("task", "create", "ONE", "--title", "Widget archived");
    run("task", "create", "ONE", "--title", "Widget also archived");
    run("task", "create", "TWO", "--title", "Widget elsewhere");
    run("task", "archive", "ONE-2");
    run("task", "archive", "ONE-3");

    const active = run("task", "search", "widget", "one");
    expect(active.code).toBe(0);
    expect(active.stdout).toBe(`ONE-1 | Backlog | - | Widget active\n`);
    expect(active.stderr).toBe("2 archived matches hidden, use --all to include them\n");

    const activeJson = run("task", "search", "widget", "ONE", "--json");
    expect(JSON.parse(activeJson.stdout)).toHaveLength(1);
    expect(activeJson.stdout).not.toContain("hidden");
    expect(activeJson.stderr).toBe("2 archived matches hidden, use --all to include them\n");

    const single = run("task", "search", "ONE-2", "ONE");
    expect(single.stdout).toBe("");
    expect(single.stderr).toBe("1 archived match hidden, use --all to include them\n");

    const archived = run("task", "search", "widget", "ONE", "--archived");
    expect(archived.stderr).toBe("");
    expect(archived.stdout.trimEnd().split("\n").sort()).toEqual([
      `ONE-2 | Backlog | - | Widget archived`,
      `ONE-3 | Backlog | - | Widget also archived`,
    ]);

    const all = run("task", "search", "widget", "--all");
    expect(all.stderr).toBe("");
    expect(all.stdout.trimEnd().split("\n")).toHaveLength(4);
    expect(all.stdout).toContain(`ONE-2 | Archived | Backlog | - | Widget archived`);
    expect(all.stdout).toContain(`TWO-1 | Active   | Backlog | - | Widget elsewhere`);

    expect(run("task", "search", "widget", "--all", "--limit", "3").stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(run("task", "search", "widget", "TWO").stdout).toBe(`TWO-1 | Backlog | - | Widget elsewhere\n`);
  });
});

test("task search validates its arguments", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "VAL"], dir);

    const cases: Array<[Array<string>, string]> = [
      [[], "A search query must be specified"],
      [[""], "Search query cannot be blank"],
      [["a", "VAL", "extra"], "quote multi-word queries"],
      [["a", "--archived", "--all"], 'Use either "--archived" or "--all", not both'],
      [["a", "--limit", "0"], "Search limit must be a positive integer"],
      [["a", "--limit", "two"], "Search limit must be a positive integer"],
      [["a", "--limit", "0x5"], "Search limit must be a positive integer"],
      [["a", "--limit", "1e1"], "Search limit must be a positive integer"],
      [["a", "--limit", " 5 "], "Search limit must be a positive integer"],
      [["a", "--limit", "5."], "Search limit must be a positive integer"],
      [["a", "--limit", "1", "--limit", "2"], 'Option "--limit" can only be specified once'],
      [["a", "MISSING"], 'Project with key "MISSING" does not exist'],
    ];

    for (const [args, message] of cases) {
      const result = runZinn(["task", "search", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });
});

// --- NOT YET TESTABLE

// ? Do not assert merely that stdout is JSON-parseable: `console.info` renders
// ? a flat string array as `[ "Backlog", ... ]`, which parses by coincidence.
// ? Assert the entity shape instead.
test("--json emits machine-readable output on read commands", () => {
  runZinn(["project", "create", "JSON", "--name", "Json"]);

  const result = runZinn(["project", "column", "list", "JSON", "--json"]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toBeArray();
  expect(parsed[0]).toMatchObject({ name: "Backlog" });
});

test("--json prints the created entity on write commands, wherever the flag is placed", () => {
  withIsolatedZinnDir((testDir) => {
    const project = runZinn(["project", "create", "--json", "WEB", "--name", "Web"], testDir);
    expect(JSON.parse(project.stdout)).toEqual({ key: "WEB", name: "Web", description: null });

    const created = runZinn(["task", "create", "WEB", "--title", "Ship it", "--json"], testDir);

    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
    });
  });
});

test("--json combines a task and its relations into one document on task view", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);
    runZinn(["task", "create", "WEB", "--title", "API"], testDir);
    runZinn(["task", "create", "WEB", "--title", "UI"], testDir);
    runZinn(["task", "relation", "create", "WEB-2", "WEB-1", "--type", "dependency"], testDir);

    const viewed = JSON.parse(runZinn(["task", "view", "WEB-2", "--json"], testDir).stdout);

    expect(viewed).toMatchObject({ key: "WEB-2", title: "UI" });
    expect(viewed.relations).toEqual([
      {
        type: "dependency",
        direction: "outgoing",
        task: { key: "WEB-1", title: "API", status: "Active" },
      },
    ]);
  });
});

test("--json prints an empty array for empty lists, while text output stays empty", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "list"], testDir).stdout).toBe("");
    expect(JSON.parse(runZinn(["project", "list", "--json"], testDir).stdout)).toEqual([]);
    expect(JSON.parse(runZinn(["label", "list", "--json"], testDir).stdout)).toEqual([]);
  });
});

test("--json reports errors as JSON on stderr and leaves stdout empty", () => {
  const result = runZinn(["project", "create", "--json"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    error: { message: "Project key must be specified" },
  });
});

test("--json refuses commands that ask for confirmation without --yes, deleting nothing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);

    const result = runZinnWithConfirmation(["project", "delete", "WEB", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { message: "Commands that ask for confirmation need --yes when used with --json" },
    });
    expect(runZinn(["project", "list"], testDir).stdout).toBe("WEB | WEB\n");
  });
});

test("--yes deletes without asking for confirmation", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "WEB"], testDir);
    runZinn(["task", "create", "WEB", "--title", "Ship it"], testDir);

    // ? runZinn gives no stdin, so without --yes the prompt would be declined.
    const result = runZinn(["task", "delete", "WEB-1", "--yes"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Deleted WEB-1 | Backlog | Ship it\n`);
    expect(runZinn(["task", "list", "WEB"], testDir).stdout).toBe("");
  });
});

test("delete commands with --yes and --json print the deleted entity", () => {
  withIsolatedZinnDir((testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const deleteJson = (...args: Array<string>) => {
      const result = run(...args, "--yes", "--json");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };

    run("project", "create", "WEB", "--name", "Web");
    run("project", "create", "GONE", "--name", "Gone");
    run("task", "create", "WEB", "--title", "Ship it");
    run("task", "create", "WEB", "--title", "Keep it");
    run("task", "comment", "create", "WEB-2", "--text", "Looks good");
    run("label", "create", "urgent", "--color", "red", "--description", "Needs attention soon");

    expect(deleteJson("task", "delete", "WEB-1")).toEqual({
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      title: "Ship it",
      description: null,
      priority: null,
      labels: [],
    });
    expect(JSON.parse(run("task", "list", "WEB", "--json").stdout)).toMatchObject([
      { key: "WEB-2" },
    ]);

    const deletedComment = deleteJson("task", "comment", "delete", "WEB-2#1");
    expect(deletedComment).toEqual({
      key: "WEB-2#1",
      text: "Looks good",
      created_at: deletedComment.created_at,
      updated_at: deletedComment.updated_at,
    });
    expect(JSON.parse(run("task", "comment", "list", "WEB-2", "--json").stdout)).toEqual([]);

    expect(deleteJson("label", "delete", "urgent")).toEqual({
      name: "urgent",
      color: "red",
      description: "Needs attention soon",
    });
    expect(JSON.parse(run("label", "list", "--json").stdout)).toEqual([]);

    expect(deleteJson("project", "delete", "GONE")).toEqual({ key: "GONE", name: "Gone", description: null });
    expect(JSON.parse(run("project", "list", "--json").stdout)).toEqual([
      { key: "WEB", name: "Web", description: null },
    ]);
  });
});

// #TODO(build): the exit-code table from NOTES.md ("Output contract", still
// #TODO open) — distinct nonzero codes for not-found vs invalid-input vs DB
// #TODO error. Everything currently exits 1 via `quit`, so the tests above
// #TODO cannot distinguish "project missing" from "wrong number of args".
test.todo("failure classes have distinct exit codes", () => {
  expect(runZinn(["project", "delete", "NOSUCH"]).code).toBe(4); // ? not found
  expect(runZinn(["project", "create"]).code).toBe(2); // ? invalid input
});

// #TODO(refactor): `quit()` calls `process.exit`, so a handler cannot be called
// #TODO in-process without taking the runner down — every case here pays a
// #TODO subprocess spawn for it. NOTES.md records the fix: handlers throw,
// #TODO `index.ts` catches and exits. Then the router/handler layer gets fast
// #TODO in-process unit tests and this file shrinks to a thin smoke suite.
test.todo("handlers throw instead of exiting, so they can be tested in-process", async () => {
  const { projectRouter } = await import("./src/routes/project-router");

  expect(() => projectRouter.create.run([])).toThrow(
    "Project key must be specified",
  );
});


test("project edit renames without changing identity, tasks, columns, or archive state", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    runZinn(["task", "create", "EDIT", "--title", "Keep task"], dir);
    const read = () => withTestDb(dir, (db) => ({
      project: db.query<import("../core/src/types").Project, []>("SELECT * FROM project").get()!,
      tasks: db.query("SELECT * FROM task").all(),
      columns: db.query("SELECT * FROM project_column").all(),
    }));
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1, archived_at = 2"));
    const before = read();
    const result = runZinn(["project", "edit", "edit", "--name", "New name"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("EDIT | New name\n");
    expect(result.stderr).toBe("");
    const after = read();
    expect(after).toEqual({ ...before, project: {
      ...before.project, name: "New name", updated_at: after.project.updated_at,
    } });
    expect(after.project.updated_at).toBeGreaterThan(1);
    withTestDb(dir, (db) => db.run("UPDATE project SET updated_at = 1"));
    expect(runZinn(["project", "edit", "EDIT", "--name", "New name"], dir).code).toBe(0);
    expect(read().project.updated_at).toBe(1);
    expect(runZinn(["project", "edit", "--name=--example", "EDIT"], dir).code).toBe(0);
    expect(runZinn(["project", "list"], dir).stdout).toContain("EDIT | --example");
  });
});

test("project edit rejects invalid requests without writes", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "EDIT", "--name", "Original"], dir);
    const read = () => withTestDb(dir, (db) => db.query("SELECT * FROM project").get());
    const before = read();
    const cases: Array<[string[], string]> = [
      [[], "Project key must be specified"],
      [["EDIT"], "Provide an edit flag"],
      [["EDIT", "--name"], "argument missing"],
      [["EDIT", "--key", "NEW"], "Unknown option"],
      [["EDIT", "extra", "--name", "Name"], "Only one project key"],
      [["EDIT", "--name", "One", "--name", "Two"], "only be specified once"],
      [["EDIT", "--name", ""], "blank or contain line breaks or control characters"],
      [["EDIT", "--name", "   "], "blank or contain line breaks or control characters"],
      [["EDIT", "--name", "Two\nlines"], "blank or contain line breaks or control characters"],
      [["MISSING", "--name", "Name"], "does not exist"],
    ];
    for (const [args, message] of cases) {
      const result = runZinn(["project", "edit", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
      expect(read()).toEqual(before);
    }
  });
});

// --- RELATIONS

test("relation commands show directional and symmetric links, including archived cross-project tasks", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    expect(run("project", "create", "OTHER").code).toBe(0);
    run("task", "create", "APP", "--title", "Copy");
    run("task", "create", "OTHER", "--title", "Original");
    expect(run("task", "relation", "list", "APP-1").stdout).toBe("");
    expect(run("task", "relation", "create", "APP-1", "APP-1", "--type", "related").stderr).toContain("itself");
    expect(run("task", "relation", "create", "APP-1", "OTHER-99", "--type", "related").code).toBe(1);
    expect(run("task", "relation", "list", "OTHER-99").code).toBe(1);
    for (const type of ["dependency", "duplicate", "related", "subtask"]) {
      const created = run("task", "relation", "create", "app-1", "OTHER-1", "--type", type);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("APP-1");
      expect(created.stdout).toContain("OTHER-1");
    }
    const outgoing = run("task", "relation", "list", "APP-1");
    expect(outgoing.stdout).toContain("Depends on | OTHER-1 | Original");
    expect(outgoing.stdout).toContain("Duplicate of | OTHER-1 | Original");
    expect(outgoing.stdout).toContain("Parent | OTHER-1 | Original");
    const incoming = run("task", "relation", "list", "OTHER-1");
    expect(incoming.stdout).toContain("Subtask | APP-1 | Copy");
    expect(incoming.stdout).toContain("Depended on by | APP-1 | Copy");
    expect(incoming.stdout).toContain("Duplicated by | APP-1 | Copy");
    expect(incoming.stdout).toContain("Related to | APP-1 | Copy");
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "related").stderr).toContain("already exists");
    run("task", "archive", "OTHER-1");
    expect(run("task", "view", "APP-1").stdout).toContain("Parent | OTHER-1 | Original | Archived");
    const viewed = JSON.parse(run("task", "view", "APP-1", "--json").stdout);
    expect(viewed.relations).toContainEqual({
      type: "subtask", direction: "outgoing",
      task: { key: "OTHER-1", title: "Original", status: "Archived" },
    });
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "subtask").stderr).toContain("cycle");
    expect(run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", "subtask").code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).not.toContain("Parent |");
    expect(run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "dependency").code).toBe(0);
  });
});

test("relation help and argument errors make types discoverable without prompting", () => {
  for (const args of [
    ["APP-1", "APP-2"],
    ["APP-1", "APP-2", "--type", "unknown"],
  ]) {
    const result = runZinn(["task", "relation", "create", ...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("related, dependency, duplicate, subtask");
  }
  for (const args of [
    ["APP-1", "--type", "related"],
    ["APP-1", "APP-2", "APP-3", "--type", "related"],
    ["APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
    ["APP-1", "APP-2", "--typo", "related"],
  ]) {
    expect(runZinn(["task", "relation", "create", ...args]).code).toBe(1);
  }
  const help = runZinn(["task", "relation", "create", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Source is a duplicate of target");
  expect(runZinn(["task", "relation", "--help"]).stdout).toContain("  {create|list|delete}");
  expect(runZinn(["task", "relation", "list"]).code).toBe(1);
  expect(runZinn(["task", "relation", "list", "APP-1", "APP-2"]).code).toBe(1);
});

test("relation deletion is usable without a prompt and updates list and view", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("project", "create", "APP");
    run("task", "create", "APP", "--title", "First");
    run("task", "create", "APP", "--title", "Second");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    run("task", "relation", "create", "APP-1", "APP-2", "--type", "dependency");
    const removed = run("task", "relation", "delete", "app-2", "APP-1", "--type", "related");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Deleted related relation from APP-2 to APP-1");
    expect(run("task", "relation", "list", "APP-1").stdout).toContain("Depends on");
    expect(run("task", "view", "APP-2").stdout).not.toContain("Related to");
    expect(run("task", "relation", "delete", "APP-1", "APP-2", "--type", "related").stderr).toContain("does not exist");
    for (const args of [[], ["APP-1"], ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "invalid"],
      ["APP-1", "APP-2", "--type", "related", "--type", "dependency"],
    ]) {
      expect(run("task", "relation", "delete", ...args).code).toBe(1);
    }
    expect(run("task", "relation", "delete", "--help").stdout).toContain("Remove only the specified relation");
    expect(run("task", "relation", "--help").stdout).toContain("  {create|list|delete}");
  });
});

test("global label workflows support repeated create/edit flags and preserve task content", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    for (const name of ["bug", "auth", "needs review, soon"]) {
      expect(run("label", "create", name, "--color", "red", "--description", "Details").code).toBe(0);
    }
    expect(run("label", "create", "BUG").stderr).toContain("already exists");
    expect(run("label", "create", "invalid", "--color", "purple").code).toBe(1);
    expect(run("label", "list").stdout).toContain("bug | red | Details");
    const created = run("task", "create", "APP", "--title", "Login", "--description", "", "--label", "BUG", "--label", "AUTH");
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Labels: auth, bug");
    const editedLabel = run("label", "edit", " BUG ", "--name", " defect ", "--color", "blue", "--description", "");
    expect(editedLabel.code).toBe(0);
    expect(editedLabel.stdout).toBe("defect | blue\n");
    expect(run("task", "view", "APP-1").stdout).toContain("Labels: auth, defect");
    expect(JSON.parse(run("label", "edit", "defect", "--description", "Fixed", "--json").stdout)).toEqual({
      name: "defect",
      color: "blue",
      description: "Fixed",
    });
    expect(run("task", "edit", "APP-1", "--title", "Changed", "--add-label", "NEEDS REVIEW, SOON", "--add-label", "AUTH", "--remove-label", "DEFECT").code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).toContain("Labels: auth, needs review, soon");
    expect(run("task", "edit", "APP-1", "--title", "Must not change", "--add-label", "unknown").code).toBe(1);
    expect(run("task", "view", "APP-1").stdout).toContain("Changed");
    expect(run("task", "edit", "APP-1", "--add-label", "BUG", "--remove-label", "bug").code).toBe(1);
    expect(run("task", "label", "add", "APP-1", "DEFECT").stdout).toContain("Labels: auth, defect, needs review, soon");
    expect(run("task", "label", "remove", "APP-1", "AUTH", "dEfEcT").stdout).toContain("Labels: needs review, soon");
    expect(runZinnWithConfirmation(["label", "delete", "NEEDS REVIEW, SOON"], dir).code).toBe(0);
    expect(run("task", "view", "APP-1").stdout).not.toContain("Labels:");
    expect(run("label", "list").stdout).toContain("auth");
    for (const args of [
      ["APP", "Old positional title"],
      ["APP", "--title", "One", "--title", "Two"],
      ["APP", "--title", "One", "--description", "A", "--description", "B"],
      ["APP", "--title", "One", "--unknown", "x"],
      ["APP", "--title", "One", "--label", "missing"],
    ]) {
      expect(run("task", "create", ...args).code).toBe(1);
    }
    expect(run("task", "create", "APP", "--title=--example").stdout).toContain("APP-2");
  });
});

test("label text output colors the name in a terminal and names the color when piped, while JSON keeps the color value", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);

    expect(run("label", "create", "bug", "--color", "red", "--description", "Broken").stdout).toBe(
      "bug | red | Broken\n",
    );
    expect(run("label", "create", "later").stdout).toBe("later | white\n");

    const createdInTerminal = await runZinnInTerminal(["label", "create", "chore", "--color", "gray"], dir);
    expect(createdInTerminal.code).toBe(0);
    expect(createdInTerminal.output).toBe("\x1b[90mchore\x1b[39m\n");

    const listed = run("label", "list").stdout;
    expect(listed).not.toContain("\x1b[");
    for (const line of ["bug | red | Broken", "chore | gray", "later | white"]) {
      expect(listed).toContain(`${line}\n`);
    }
    const listedInTerminal = (await runZinnInTerminal(["label", "list"], dir)).output;
    expect(listedInTerminal).toContain("\x1b[31mbug\x1b[39m | Broken\n");
    for (const colorName of ["red", "white", "gray"]) {
      expect(listedInTerminal).not.toContain(colorName);
    }

    const created = run("label", "create", "docs", "--color", "cyan", "--json").stdout;
    expect(created).not.toContain("\x1b[");
    expect(JSON.parse(created)).toEqual({ name: "docs", color: "cyan", description: null });

    const listedJson = run("label", "list", "--json").stdout;
    expect(listedJson).not.toContain("\x1b[");
    expect(JSON.parse(listedJson)).toContainEqual({ name: "bug", color: "red", description: "Broken" });
  });
});

test("NO_COLOR turns color off in a terminal, so text output reads as it does when piped", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["project", "create", "PLAIN"], dir);
    runZinn(["task", "create", "PLAIN", "--title", "waiting"], dir);
    runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const noColor = { NO_COLOR: "1" };
    expect((await runZinnInTerminal(["task", "list", "PLAIN"], dir, noColor)).output).toBe(
      "PLAIN-1 | Backlog | - | waiting\n",
    );
    expect((await runZinnInTerminal(["label", "list"], dir, noColor)).output).toBe(
      "bug | red | Broken\n",
    );

    // An empty NO_COLOR counts as unset.
    expect((await runZinnInTerminal(["label", "list"], dir, { NO_COLOR: "" })).output).toBe(
      "\x1b[31mbug\x1b[39m | Broken\n",
    );
  });
});

test("FORCE_COLOR colors piped output and wins over NO_COLOR, while FORCE_COLOR=0 turns color off", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    runZinn(["project", "create", "FORCE"], dir);
    runZinn(["task", "create", "FORCE", "--title", "waiting"], dir);
    runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const coloredLabel = "\x1b[31mbug\x1b[39m | Broken\n";
    expect(runZinn(["task", "list", "FORCE"], dir, { FORCE_COLOR: "1" }).stdout).toBe(
      `FORCE-1 | ${GRAY_BACKLOG} | - | waiting\n`,
    );
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "1", NO_COLOR: "1" }).stdout).toBe(coloredLabel);

    // Any non-empty value other than 0 forces color; an empty FORCE_COLOR counts as unset.
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "true" }).stdout).toBe(coloredLabel);
    expect(runZinn(["label", "list"], dir, { FORCE_COLOR: "" }).stdout).toBe("bug | red | Broken\n");
    expect((await runZinnInTerminal(["label", "list"], dir, { FORCE_COLOR: "0" })).output).toBe(
      "bug | red | Broken\n",
    );
  });
});

test("label namespaces and commands expose help without initializing storage", () => {
  withIsolatedZinnDir((dir) => {
    for (const args of [["label"], ["label", "create"], ["label", "edit"], ["label", "list"], ["label", "delete"], ["task", "label"], ["task", "label", "add"], ["task", "label", "remove"]]) {
      for (const flag of ["-h", "--help"]) {
        const result = runZinn([...args, flag], dir);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("TODO");
      }
    }
    expect(Bun.file(join(dir, "data", "zinn.sqlite")).size).toBe(0);
  });
});

test("opening an existing board adds label storage without losing task data", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "KEEP"], dir);
    runZinn(["task", "create", "KEEP", "--title", "Existing task"], dir);
    withTestDb(dir, (db) => {
      db.run("DROP TABLE task_label");
      db.run("DROP TABLE label");
    });
    expect(runZinn(["label", "create", "bug"], dir).code).toBe(0);
    expect(runZinn(["task", "label", "add", "KEEP-1", "bug"], dir).code).toBe(0);
    const taskView = runZinn(["task", "view", "KEEP-1"], dir);
    expect(taskView.stdout).toContain("Existing task");
    expect(taskView.stdout).toContain("Labels: bug");
    expect(runZinnWithConfirmation(["task", "delete", "KEEP-1"], dir).code).toBe(0);
    expect(runZinn(["label", "list"], dir).stdout).toContain("bug");
  });
});

test("label deletion confirms global removal and cancellation preserves attachments and timestamps", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("project", "create", "APP");
    run("label", "create", "bug");
    run("label", "create", "keep");
    run("task", "create", "APP", "--title", "First", "--label", "bug", "--label", "keep");
    run("task", "create", "APP", "--title", "Second", "--label", "bug");
    const snapshot = () => withTestDb(dir, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    }));
    const before = snapshot();
    const cancelled = run("label", "delete", "bug");
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain('delete label "bug" and remove it from all tasks?');
    expect(cancelled.stdout).toContain('Deletion cancelled for label "bug"');
    expect(snapshot()).toEqual(before);
    const deleted = runZinnWithConfirmation(["label", "delete", "bug"], dir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain('Deleted label "bug"');
    expect(run("label", "list").stdout).toContain("keep");
    expect(run("label", "list").stdout).not.toContain("bug");
    expect(run("task", "view", "APP-1").stdout).toContain("Labels: keep");
    expect(run("task", "view", "APP-2").code).toBe(0);
    withTestDb(dir, (db) => {
      expect(db.query("SELECT * FROM task_label").all()).toHaveLength(1);
      expect(db.query("SELECT * FROM task").all()).toHaveLength(2);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    const missing = run("label", "delete", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("Are you sure");
    expect(run("label", "delete", "--help").stdout).toContain("after confirmation");
  });
});

test("shared option checks reject repeated scalar flags and retain positional validation", () => {
  withIsolatedZinnDir((dir) => {
    for (const args of [
      ["label", "create", "bug", "--color", "red", "--color", "blue"],
      ["label", "create", "bug", "--description", "a", "--description", "b"],
      ["label", "edit", "bug", "--name", "a", "--name", "b"],
      ["label", "edit", "bug", "--color", "red", "--color", "blue"],
      ["label", "edit", "bug", "--description", "a", "--description", "b"],
      ["project", "create", "APP", "--name", "a", "--name", "b"],
      ["project", "edit", "APP", "--name", "a", "--name", "b"],
      ["task", "edit", "APP-1", "--title", "a", "--title", "b"],
      ["task", "relation", "create", "APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
    ]) {
      const result = runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("can only be specified once");
    }
    for (const args of [["label", "create"], ["label", "create", "one", "two"], ["label", "edit"], ["label", "edit", "one", "two", "--color", "red"], ["label", "delete", "one", "two"]]) {
      expect(runZinn(args, dir).stderr).toContain("Exactly one label name is required");
    }
  });
});

test("label edit validates changes, uniqueness, and missing labels", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    run("label", "create", "bug");
    run("label", "create", "auth");

    expect(run("label", "edit", "bug").stderr).toContain("Provide at least one field to edit");
    expect(run("label", "edit", "missing", "--color", "red").stderr).toContain("does not exist");
    expect(run("label", "edit", "BUG", "--name", "Bug").stdout).toContain("Bug");
    expect(run("label", "edit", "bug", "--name", "AUTH").stderr).toContain("already exists");
    expect(run("label", "edit", "BUG", "--name", " ").stderr).toContain("cannot be blank");
    expect(run("label", "edit", "BUG", "--color", "purple").code).toBe(1);
    expect(run("label", "list", "--json").stdout).toContain('"name": "Bug"');
    expect(run("label", "edit", "--help").stdout).toContain("Editing does not affect task attachments or task timestamps");
    expect(runZinn(["--help"], dir).stdout).toContain("label {create|list|edit|delete}");
  });
});

test("priority persists across CLI creation, editing, listing, clearing, and no-op edits", () => {
  withIsolatedZinnDir((directory) => {
    expect(runZinn(["task", "list", "--help"], directory).stdout).toContain(
      "Priority markers: - unassigned, L low, M medium, H high, U urgent.",
    );
    expect(runZinn(["project", "create", "PRI"], directory).code).toBe(0);
    expect(runZinn(["task", "create", "PRI", "--title", "Default"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ priority: string | null }, []>("SELECT priority FROM task").get()!.priority).toBeNull();
    });
    for (const priority of ["low", "medium", "high", "urgent"]) {
      const created = runZinn(["task", "create", "PRI", "--title", priority, "--priority", priority], directory);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(`Priority: ${priority}`);
    }
    expect(runZinn(["task", "list", "PRI"], directory).stdout).toBe(
      [
        `PRI-1 | Backlog | - | Default`,
        `PRI-2 | Backlog | L | low`,
        `PRI-3 | Backlog | M | medium`,
        `PRI-4 | Backlog | H | high`,
        `PRI-5 | Backlog | U | urgent`,
      ].join("\n") + "\n",
    );
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBeGreaterThan(1);
    });
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBe(1);
    });
    expect(runZinn(["task", "edit", "PRI-1", "--title", "Renamed"], directory).stdout).toContain("Priority: high");
    expect(runZinn(["task", "list", "PRI"], directory).stdout).toContain(
      `PRI-1 | Backlog | H | Renamed`,
    );
    expect(runZinn(["task", "view", "PRI-1"], directory).stdout).toContain("Priority: high");
    expect(JSON.parse(runZinn(["task", "list", "PRI", "--json"], directory).stdout)[0].priority).toBe(
      "high",
    );
    const invalid = runZinn(["task", "edit", "PRI-1", "--title", "Wrong", "--priority", "critical"], directory);
    expect(invalid.code).not.toBe(0);
    expect(runZinn(["task", "view", "PRI-1"], directory).stdout).toContain("Renamed");
    expect(runZinn(["task", "archive", "PRI-1"], directory).code).toBe(0);
    expect(runZinn(["task", "edit", "PRI-1", "--priority", "none"], directory).code).toBe(0);
    withTestDb(directory, (db) => {
      const row = db.query<{ priority: string | null; archived_at: number | null }, []>("SELECT priority, archived_at FROM task WHERE number = 1").get()!;
      expect(row.priority).toBeNull();
      expect(row.archived_at).not.toBeNull();
      expect(() => db.run("UPDATE task SET priority = 'critical'")).toThrow();
    });
  });
});

// --- ACTIVITY ACTOR

const AGENT_VARIABLES = ["AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX", "OPENCODE", "GEMINI_CLI", "CLINE_ACTIVE", "CURSOR_AGENT", "COPILOT_AGENT_SESSION_ID", "CRUSH"];

// ? Agent shells carry these variables, so each case starts from an env without them.
function runZinnAs(args: Array<string>, testDir: string, env: Record<string, string>) {
  const baseEnv: Record<string, string | undefined> = { ...process.env, ZINN_DIR: testDir, GIT_CONFIG_NOSYSTEM: "1" };
  for (const variable of AGENT_VARIABLES) {
    delete baseEnv[variable];
  }

  // ? cwd outside any repository, so only the identity file given per case applies.
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], { cwd: testDir, env: { ...baseEnv, ...env } });
  return { stderr: proc.stderr.toString(), code: proc.exitCode };
}

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string; actor_email: string | null; actor_kind: string }, []>(
      "SELECT action, actor_name, actor_email, actor_kind FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", () => {
  withIsolatedZinnDir((dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect(runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent" });
    expect(runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent" });

    expect(runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human" });

    expect(runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null" }).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human" });
  });
});

// --- BACKUP

test("backup saves a copy of the database named with the UTC time and CLI version", () => {
  withIsolatedZinnDir((dir) => {
    runZinn(["project", "create", "BAK"], dir);
    runZinn(["task", "create", "BAK", "--title", "Saved"], dir);

    const result = runZinn(["backup", "--json"], dir);
    expect(result.code).toBe(0);

    const { path } = JSON.parse(result.stdout) as { path: string };
    expect(dirname(path)).toBe(join(dir, "backups"));
    expect(basename(path)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    expect(basename(path)).toEndWith(`Z-cli-${packageJson.version}.sqlite`);

    const backupDb = new Database(path, { readonly: true });
    try {
      expect(backupDb.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
      expect(backupDb.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      backupDb.close();
    }
  });
});

test("backup refuses when there is no database and does not create one", () => {
  withIsolatedZinnDir((dir) => {
    const result = runZinn(["backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`There is no Zinn database at ${join(dir, "data", "zinn.sqlite")} to back up`);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});


test("all CLI descriptions normalize blank input and preserve meaningful formatting", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect(run("project", "create", "APP").code).toBe(0);
    const entities = [
      { type: "project", create: ["EMPTY"], editKey: "EMPTY", read: ["project", "view", "EMPTY"] },
      { type: "task", create: ["APP", "--title", "Empty"], editKey: "APP-1", read: ["task", "view", "APP-1"] },
      { type: "label", create: ["empty"], editKey: "empty", read: ["label", "list"] },
    ];

    for (const entity of entities) {
      const created = run(entity.type, "create", ...entity.create, "--description", " \n\t ", "--json");
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout).description).toBeNull();
      for (const clearInput of ["", " \n\t "]) {
        const description = "  Details\n\tIndented  \n";
        const edited = run(entity.type, "edit", entity.editKey, "--description", description, "--json");
        expect(edited.code).toBe(0);
        expect(JSON.parse(edited.stdout).description).toBe(description);
        const cleared = run(entity.type, "edit", entity.editKey, "--description", clearInput, "--json");
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout).description).toBeNull();
      }
      const result = JSON.parse(run(...entity.read, "--json").stdout);
      expect((Array.isArray(result) ? result[0] : result).description).toBeNull();
    }

    expect(JSON.parse(run("project", "create", "OMITTED", "--json").stdout).description).toBeNull();
    expect(JSON.parse(run("task", "create", "APP", "--title", "Omitted", "--json").stdout).description).toBeNull();
    expect(JSON.parse(run("label", "create", "omitted", "--json").stdout).description).toBeNull();
  });
});

test("project descriptions flow through creation, partial edits, view, list and clearing", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "Purpose\nMore context";
    const created = run("project", "create", "DESC", "--description", description, "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ key: "DESC", name: "DESC", description });
    expect(run("project", "view", "DESC").stdout).toBe("DESC | DESC | Purpose More context\n");
    expect(run("project", "list").stdout).toBe("DESC | DESC | Purpose More context\n");
    expect(JSON.parse(run("project", "list", "--json").stdout)[0].description).toBe(description);
    expect(JSON.parse(run("project", "edit", "DESC", "--name", "Renamed", "--json").stdout).description).toBe(description);
    expect(JSON.parse(run("project", "edit", "DESC", "--description", "Updated", "--json").stdout)).toEqual({ key: "DESC", name: "Renamed", description: "Updated" });
    expect(run("project", "edit", "DESC", "--description", "").stdout).toBe("DESC | Renamed\n");
    expect(JSON.parse(run("project", "view", "DESC", "--json").stdout).description).toBeNull();
    expect(run("project", "edit", "DESC", "--description", "a", "--description", "b").code).toBe(1);
  });
});


test("project description previews match task listings and JSON retains full text", () => {
  withIsolatedZinnDir((dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "  Context\n" + "x".repeat(200);
    const taskProject = JSON.parse(run("project", "create", "PRE", "--description", description, "--json").stdout);
    run("task", "create", "PRE", "--title", "Task", "--description", description);
    const preview = run("task", "list", "PRE").stdout.trimEnd().split(" | ").at(-1)!;
    expect(preview.endsWith("…")).toBe(true);
    expect(run("project", "list").stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(run("project", "view", "PRE").stdout.split("\n")[0]).toBe(`PRE | PRE | ${preview}`);
    expect(run("project", "edit", "PRE", "--description", description).stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(taskProject.description).toBe(description);
    expect(JSON.parse(run("project", "view", "PRE", "--json").stdout).description).toBe(description);
    expect(run("project", "edit", "PRE", "--description", " \n ").stdout).toBe("PRE | PRE\n");
  });
});

// --- CONCURRENCY (ZINN-68)

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    for (const operation of ["list", "create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinnAsync(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store),
        ));

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        }
        expect(readFileSync(join(store, "settings.json"), "utf8")).toBe("{}\n");
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
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "BEN"], dir).code).toBe(0);
    expect(runZinn(["task", "create", "BEN", "--title", "comment-target"], dir).code).toBe(0);
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
        return { kind, token, ...await runZinnAsync(args, dir) };
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

test("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "WAIT"], dir).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinnAsync(["task", "create", "WAIT", "--title", "waited", "--json"], dir);
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

test("persistent contention times out without a partial CLI mutation", async () => {
  await withIsolatedZinnDirAsync(async (dir) => {
    expect(runZinn(["project", "create", "LOCK"], dir).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinnAsync(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.message).toContain("database is locked");
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

test("CLI initialization errors expose the underlying message and code", () => {
  withIsolatedZinnDir((dir) => {
    mkdirSync(join(dir, "data"));
    const contents = "not a SQLite database";
    const path = join(dir, "data", "zinn.sqlite");
    writeFileSync(path, contents);
    const result = runZinn(["project", "list", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.message).toContain("There was a problem initializing Zinn:");
    expect(JSON.parse(result.stderr).error.message).toContain("file is not a database (SQLITE_NOTADB)");
    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});
