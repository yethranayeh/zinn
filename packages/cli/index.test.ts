import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

afterAll(() => {
  if (!TEST_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

function withIsolatedZinnDir(run: (testDir: string) => void) {
  const testDir = mkdtempSync(PREFIX);

  try {
    run(testDir);
  } finally {
    if (!testDir.startsWith(PREFIX)) {
      throw new Error(`Refusing to delete "${testDir}": not a ${PREFIX}* directory`);
    }

    rmSync(testDir, { recursive: true, force: true });
  }
}

function runZinn(args: Array<string>, testDir = TEST_DIR) {
  const proc = Bun.spawnSync(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ZINN_DIR: testDir },
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

test("bare invocation in a non-TTY exits nonzero", () => {
  // ? `spawnSync` gives the child no TTY, which is exactly the CI case this guards.
  const result = runZinn([]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("non-TTY environment is not supported");
});

test("--help prints usage to stdout and exits zero", () => {
  const result = runZinn(["--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("ZINN - A kanban workflow in the terminal");
});

// --- ROUTING

test("an unrecognized command exits nonzero", () => {
  const result = runZinn(["task", "destroy", "WIP"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unrecognized command");
});

test("a nested route resolves past its namespace", () => {
  runZinn(["project", "create", "Nested", "NEST"]);

  // ? `project column list` is three tokens deep; proves the router peels the
  // ? namespace prefix and forwards only "NEST" as the command args.
  const result = runZinn(["project", "column", "list", "NEST"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Backlog");
});

// --- PROJECT

test("project create seeds the default columns", () => {
  expect(runZinn(["project", "create", "Work", "WIP"]).code).toBe(0);

  const listed = runZinn(["project", "column", "list", "WIP"]);

  expect(listed.code).toBe(0);
  // #TODO(refactor): `project column list` prints a raw JS array via `console.info`,
  // #TODO so this asserts on inspect formatting rather than a real output contract.
  // #TODO Tighten once `--json` lands (see the output-contract TODO below).
  expect(listed.stdout).toContain("Backlog");
  expect(listed.stdout).toContain("In Progress");
  expect(listed.stdout).toContain("Done");
});

test("project create requires both a name and a key", () => {
  const result = runZinn(["project", "create", "OnlyAName"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Both the project name and the project key must be defined");
});

test("project create rejects a duplicate key regardless of casing", () => {
  expect(runZinn(["project", "create", "First", "DUP"]).code).toBe(0);

  const second = runZinn(["project", "create", "Second", "dup"]);

  expect(second.code).toBe(1);
  expect(second.stderr).toContain(`Project with key "DUP" already exists!`);
});

test("project column create rejects a duplicate name regardless of casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Columns", "COL"], testDir);
    expect(runZinn(["project", "column", "create", "COL", "Later"], testDir).code).toBe(0);

    const duplicate = runZinn(["project", "column", "create", "COL", "later"], testDir);

    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain(
      `Column with name "later" already exists in project "COL"!`,
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

test("project column names are unique only within a project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Alpha", "ALPHA"], testDir);
    runZinn(["project", "create", "Beta", "BETA"], testDir);

    const alpha = runZinn(["project", "column", "create", "ALPHA", "QA"], testDir);
    const beta = runZinn(["project", "column", "create", "BETA", "qa"], testDir);

    expect(alpha.code).toBe(0);
    expect(beta.code).toBe(0);
  });
});

test("project delete accepts a non-standardized key", () => {
  runZinn(["project", "create", "Doomed", "GONE"]);

  expect(runZinn(["project", "delete", "gone"]).code).toBe(0);

  // ? Reading the columns back is the only way to observe the project is gone
  // ? until `project list` exists.
  const listed = runZinn(["project", "column", "list", "GONE"]);
  expect(listed.code).toBe(1);
  expect(listed.stderr).toContain("does not exist");
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
    expect(runZinn(["project", "create", "Short", "a"], testDir).code).toBe(0);
    expect(runZinn(["project", "create", "Long", "LONGKEY"], testDir).code).toBe(0);

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
    runZinn(["project", "create", "Keep", "KEEP"], testDir);
    runZinn(["project", "create", "Remove", "REMOVE"], testDir);
    expect(runZinn(["project", "delete", "REMOVE"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KEEP");
    expect(result.stdout).not.toContain("REMOVE");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project create accepts an alphanumeric key in any casing and stores it uppercase", () => {
  withIsolatedZinnDir((testDir) => {
    expect(runZinn(["project", "create", "Business", "b2B"], testDir).code).toBe(0);

    const result = runZinn(["project", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("B2B | Business\n");
  });
});

test("project create rejects keys outside the alphanumeric contract", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidKey of ["2B", "APP-DEV", "APP_DEV", "ÅPP", ""]) {
      const result = runZinn(["project", "create", "Invalid", invalidKey], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Project key must start with a letter and contain only letters and numbers",
      );
    }
  });
});

test("project create rejects blank or non-single-line names", () => {
  withIsolatedZinnDir((testDir) => {
    for (const invalidName of ["   ", "first line\nsecond line", "name\u001b[31m"]) {
      const result = runZinn(["project", "create", invalidName, "SAFE"], testDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Project name must contain printable text on a single line");
    }
  });
});

// --- TASK

test("task create rejects an unknown project", () => {
  const result = runZinn(["task", "create", "NOPE", "orphan task"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Project with key "NOPE" does not exist`);
});

test("task create requires a project key and a title", () => {
  runZinn(["project", "create", "Args", "ARGS"]);

  expect(runZinn(["task", "create"]).stderr).toContain("A task needs to belong to a project");
  expect(runZinn(["task", "create", "ARGS"]).stderr).toContain("A task needs at least a title");
});

test("task create succeeds against an existing project", () => {
  runZinn(["project", "create", "Tasks", "TSK"]);

  const result = runZinn(["task", "create", "TSK", "first task"]);

  // The placement contract is asserted independently below.
  expect(result.code).toBe(0);
});

test("task create attaches the task to its project's first ordered column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Placed", "PLACE"], testDir);
    runZinn(["project", "column", "create", "PLACE", "Later"], testDir);

    expect(runZinn(["task", "create", "PLACE", "placed task"], testDir).code).toBe(0);

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
    runZinn(["project", "create", "Alpha", "ALPHA"], testDir);
    runZinn(["task", "create", "ALPHA", "todo first"], testDir);

    withTestDb(testDir, (db) => {
      const todoColumn = db
        .query<{ id: string }, []>("SELECT id FROM project_column WHERE name = 'TODO'")
        .get();

      expect(todoColumn).not.toBeNull();
      db.run("UPDATE task SET column_id = ? WHERE title = 'todo first'", [todoColumn!.id]);
    });

    runZinn(["task", "create", "ALPHA", "backlog first"], testDir);
    runZinn(["task", "create", "ALPHA", "backlog second"], testDir);

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

test.todo("a project without columns rejects task creation without consuming a task number", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "No columns", "EMPTYCOL"], testDir);
    withTestDb(testDir, (db) => db.run("DELETE FROM project_column"));

    const rejected = runZinn(["task", "create", "EMPTYCOL", "cannot place me"], testDir);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Project "EMPTYCOL" does not have any columns');

    runZinn(["project", "column", "create", "EMPTYCOL", "Inbox"], testDir);
    expect(runZinn(["task", "create", "EMPTYCOL", "first real task"], testDir).code).toBe(0);
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
    runZinn(["project", "create", "Short", "a"], testDir);
    runZinn(["project", "create", "Long", "LONGKEY"], testDir);
    runZinn(["task", "create", "A", "short task", "short description"], testDir);
    runZinn(["task", "create", "LONGKEY", "long task", "long description"], testDir);

    const result = runZinn(["task", "list"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("A-1       | Backlog | short task | short description");
    expect(lines).toContain("LONGKEY-1 | Backlog | long task | long description");
  });
});

test("task list does not print a missing description as data", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "No description", "NONE"], testDir);
    runZinn(["task", "create", "NONE", "title only"], testDir);

    const result = runZinn(["task", "list"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("NONE-1 | Backlog | title only");
    expect(result.stdout).not.toContain("null");
  });
});

test("task list filters to the requested project regardless of key casing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Alpha", "ALPHA"], testDir);
    runZinn(["project", "create", "Beta", "BETA"], testDir);
    runZinn(["task", "create", "ALPHA", "alpha task"], testDir);
    runZinn(["task", "create", "BETA", "beta task"], testDir);

    const result = runZinn(["task", "list", "aLpHa"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ALPHA-1 | Backlog | alpha task");
    expect(result.stdout).not.toContain("beta task");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

test("project-scoped task list follows column order and task order within each column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Ordered", "ORDER"], testDir);
    runZinn(["task", "create", "ORDER", "todo first"], testDir);
    runZinn(["task", "create", "ORDER", "backlog first"], testDir);
    runZinn(["task", "create", "ORDER", "in progress"], testDir);
    runZinn(["task", "create", "ORDER", "todo second"], testDir);
    runZinn(["task", "create", "ORDER", "backlog second"], testDir);

    runZinn(["task", "move", "ORDER-1", "TODO"], testDir);
    runZinn(["task", "move", "ORDER-3", "In Progress"], testDir);
    runZinn(["task", "move", "ORDER-4", "TODO"], testDir);

    const result = runZinn(["task", "list", "ORDER"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "ORDER-2 | Backlog | backlog first",
        "ORDER-5 | Backlog | backlog second",
        "ORDER-1 | TODO | todo first",
        "ORDER-4 | TODO | todo second",
        "ORDER-3 | In Progress | in progress",
        "",
      ].join("\n"),
    );
  });
});

test("task list for an empty project does not leak another project's tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Empty", "EMPTY"], testDir);
    runZinn(["project", "create", "Busy", "BUSY"], testDir);
    runZinn(["task", "create", "BUSY", "private task"], testDir);

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

test("project-scoped task list aligns one- and two-digit task numbers", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Ten tasks", "TEN"], testDir);
    for (let number = 1; number <= 10; number++) {
      runZinn(["task", "create", "TEN", `task ${number}`], testDir);
    }

    const result = runZinn(["task", "list", "TEN"], testDir);
    const lines = result.stdout.trimEnd().split("\n");

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(10);
    expect(lines).toContain("TEN-1  | Backlog | task 1");
    expect(lines).toContain("TEN-10 | Backlog | task 10");
  });
});

test("task view resolves a case-insensitive key and prints its canonical form", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Viewed", "VIEW"], testDir);
    runZinn(["task", "create", "VIEW", "visible task", "visible description"], testDir);

    const result = runZinn(["task", "view", "vIeW-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("VIEW-1 | Backlog | visible task | visible description\n");
  });
});

test("task view does not print a missing description as data", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "No description", "NONE"], testDir);
    runZinn(["task", "create", "NONE", "title only"], testDir);

    const result = runZinn(["task", "view", "NONE-1"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("NONE-1 | Backlog | title only\n");
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
    runZinn(["project", "create", "Known", "KNOWN"], testDir);

    const unknownProject = runZinn(["task", "view", "NOPE-1"], testDir);
    const unknownTask = runZinn(["task", "view", "KNOWN-99"], testDir);

    expect(unknownProject.code).toBe(1);
    expect(unknownProject.stderr).toContain(`Project with key "NOPE" does not exist!`);
    expect(unknownTask.code).toBe(1);
    expect(unknownTask.stderr).toContain(`Task "KNOWN-99" does not exist!`);
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
  expect(longHelp.stdout).toContain("Usage: zinn task move <task-key> <target-column>");
  expect(longHelp.stdout).toContain(
    "Moving a task to a different column lists it last in that column,",
  );
  expect(longHelp.stdout).toContain(
    "Giving a task's current column as the target will not do anything.",
  );
  expect(longHelp.stdout).toContain(
    "Archived tasks must be unarchived before they can be moved.",
  );
  expect(shortHelp.code).toBe(0);
  expect(shortHelp.stdout).toBe(longHelp.stdout);
});

test("task move rejects a column outside the task's project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Origin", "ORIGIN"], testDir);
    runZinn(["project", "create", "Other", "OTHER"], testDir);
    runZinn(["project", "column", "create", "OTHER", "External"], testDir);
    runZinn(["task", "create", "ORIGIN", "stationary task"], testDir);

    const result = runZinn(["task", "move", "ORIGIN-1", "External"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Column "External" does not exist in task "ORIGIN-1"'s project!`,
    );
    expect(runZinn(["task", "view", "ORIGIN-1"], testDir).stdout).toContain(
      "ORIGIN-1 | Backlog | stationary task",
    );
  });
});

test("task move appends the task to the destination column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Movable", "MOVE"], testDir);
    runZinn(["task", "create", "MOVE", "first task"], testDir);
    runZinn(["task", "create", "MOVE", "second task"], testDir);

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
    runZinn(["project", "create", "Still", "STILL"], testDir);
    runZinn(["task", "create", "STILL", "still task"], testDir);

    const before = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    expect(runZinn(["task", "move", "STILL-1", "Backlog"], testDir).code).toBe(0);

    const after = withTestDb(testDir, (db) =>
      db.query<{ column_id: string; task_order: string; updated_at: number }, []>(
        "SELECT column_id, task_order, updated_at FROM task WHERE title = 'still task'",
      ).get(),
    );

    expect(after).toEqual(before);
  });
});

test("task move rejects archived tasks", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Archived move", "ARCHMOVE"], testDir);
    runZinn(["task", "create", "ARCHMOVE", "archived task"], testDir);
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
    runZinn(["project", "create", "Ordered", "ORDER"], testDir);
    runZinn(["task", "create", "ORDER", "first task"], testDir);
    runZinn(["task", "create", "ORDER", "second task"], testDir);
    runZinn(["task", "create", "ORDER", "third task"], testDir);

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
    runZinn(["project", "create", "Edges", "EDGES"], testDir);
    runZinn(["task", "create", "EDGES", "first task"], testDir);
    runZinn(["task", "create", "EDGES", "second task"], testDir);
    runZinn(["task", "create", "EDGES", "third task"], testDir);

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
    runZinn(["project", "create", "Anchored", "ANCHOR"], testDir);
    runZinn(["task", "create", "ANCHOR", "first task"], testDir);
    runZinn(["task", "create", "ANCHOR", "second task"], testDir);
    runZinn(["task", "create", "ANCHOR", "third task"], testDir);
    runZinn(["task", "create", "ANCHOR", "fourth task"], testDir);
    runZinn(["task", "create", "ANCHOR", "fifth task"], testDir);

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
    runZinn(["project", "create", "Bounded", "BOUND"], testDir);
    runZinn(["task", "create", "BOUND", "backlog first"], testDir);
    runZinn(["task", "create", "BOUND", "backlog last"], testDir);
    runZinn(["task", "create", "BOUND", "progress first"], testDir);
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
    runZinn(["project", "create", "Targeted", "TARGET"], testDir);
    runZinn(["task", "create", "TARGET", "existing task"], testDir);

    const result = runZinn(["task", "order", "TARGET-1", "before", "TARGET-99"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Task "TARGET-99" does not exist!');
  });
});

test("task order rejects a target in another column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Scoped", "SCOPE"], testDir);
    runZinn(["task", "create", "SCOPE", "backlog task"], testDir);
    runZinn(["task", "create", "SCOPE", "progress task"], testDir);
    runZinn(["task", "move", "SCOPE-2", "In Progress"], testDir);

    const result = runZinn(["task", "order", "SCOPE-1", "before", "SCOPE-2"], testDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("same column");
  });
});

test("task order targeting itself is a no-op", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Unchanged", "UNCHANGED"], testDir);
    runZinn(["task", "create", "UNCHANGED", "stationary task"], testDir);

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
    runZinn(["project", "create", "Satisfied", "SATISFIED"], testDir);
    runZinn(["task", "create", "SATISFIED", "first task"], testDir);
    runZinn(["task", "create", "SATISFIED", "second task"], testDir);
    runZinn(["task", "create", "SATISFIED", "third task"], testDir);

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
    runZinn(["project", "create", "First", "FIRST"], testDir);
    runZinn(["project", "create", "Second", "SECOND"], testDir);
    runZinn(["task", "create", "FIRST", "first project task"], testDir);
    runZinn(["task", "create", "SECOND", "second project task"], testDir);

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
    runZinn(["project", "create", "Archived order", "ARCHORDER"], testDir);
    runZinn(["task", "create", "ARCHORDER", "active task"], testDir);
    runZinn(["task", "create", "ARCHORDER", "archived task"], testDir);
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
    runZinn(["project", "create", "Visible", "VISIBLE"], testDir);
    runZinn(["task", "create", "VISIBLE", "first task"], testDir);
    runZinn(["task", "create", "VISIBLE", "archived task"], testDir);
    runZinn(["task", "create", "VISIBLE", "third task"], testDir);
    runZinn(["task", "archive", "VISIBLE-2"], testDir);

    expect(runZinn(["task", "order", "VISIBLE-1", "down"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "VISIBLE"], testDir).stdout).toMatch(
      /VISIBLE-3[^\n]*\nVISIBLE-1/,
    );
  });
});

test("task archive hides a task from active lists without deleting it", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Archive", "ARCH"], testDir);
    runZinn(["task", "create", "ARCH", "kept task", "kept description"], testDir);
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
      "ARCH-1 | In Progress | kept task | kept description",
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
    runZinn(["project", "create", "Mixed archive", "MIXED"], testDir);
    runZinn(["task", "create", "MIXED", "archived task"], testDir);
    runZinn(["task", "create", "MIXED", "active task"], testDir);
    runZinn(["task", "archive", "MIXED-1"], testDir);

    expect(runZinn(["task", "list", "MIXED"], testDir).stdout).toBe(
      "MIXED-2 | Backlog | active task\n",
    );
    expect(runZinn(["task", "list", "MIXED", "--archived"], testDir).stdout).toBe(
      "MIXED-1 | Backlog | archived task\n",
    );
    expect(runZinn(["task", "list", "MIXED", "--all"], testDir).stdout).toBe(
      [
        "MIXED-2 | Active   | Backlog | active task",
        "MIXED-1 | Archived | Backlog | archived task",
        "",
      ].join("\n"),
    );
  });
});

test("task unarchive appends the task after active tasks in its previous column", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Restore order", "RESTOREORDER"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "first task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "second task"], testDir);
    runZinn(["task", "create", "RESTOREORDER", "third task"], testDir);
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
    "Unarchive a task at the bottom of its previous column.",
  );
});

test("task archive is idempotent and unarchive restores active listing", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Restore", "RESTORE"], testDir);
    runZinn(["task", "create", "RESTORE", "restorable task"], testDir);
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
  runZinn(["project", "create", "Listed", "LIST"]);

  const result = runZinn(["project", "list"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("LIST");
});

test("task delete removes the task but not its project", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Keep", "KEEP"], testDir);
    runZinn(["task", "create", "KEEP", "doomed task"], testDir);

    expect(runZinnWithConfirmation(["task", "delete", "KEEP-1"], testDir).code).toBe(0);
    expect(runZinn(["task", "list", "KEEP"], testDir).stdout).not.toContain("doomed task");
    expect(runZinn(["project", "list"], testDir).stdout).toContain("KEEP");
  });
});

test("task delete keeps the task when confirmation is declined", () => {
  withIsolatedZinnDir((testDir) => {
    runZinn(["project", "create", "Keep", "KEEP"], testDir);
    runZinn(["task", "create", "KEEP", "surviving task"], testDir);

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
    runZinn(["project", "create", "Edits", "EDIT"], dir);
    runZinn(["task", "create", "EDIT", "Original", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../core/src/types").Task, []>("SELECT * FROM task").get()!);
    withTestDb(dir, (db) => db.run("UPDATE task SET updated_at = 1"));
    const before = read();
    expect(runZinn(["task", "edit", "edit-1", "--title", "New title"], dir).code).toBe(0);
    const after = read();
    expect(after).toEqual({ ...before, title: "New title", updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(1);
    expect(runZinn(["task", "edit", "EDIT-1", "--description", ""], dir).code).toBe(0);
    expect(read().description).toBe("");
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
    runZinn(["project", "create", "Edits", "EDIT"], dir);
    runZinn(["task", "create", "EDIT", "Original", "Description"], dir);
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
    runZinn(["project", "create", "Edits", "EDIT"], dir);
    runZinn(["task", "create", "EDIT", "Original"], dir);
    runZinn(["task", "archive", "EDIT-1"], dir);
    expect(runZinn(["task", "edit", "EDIT-1", "--title", "Archived edit"], dir).code).toBe(0);
    expect(runZinn(["task", "list", "EDIT"], dir).stdout).toBe("");
    expect(runZinn(["task", "list", "EDIT", "--archived"], dir).stdout).toContain("Archived edit");
  });
  const help = runZinn(["task", "edit", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--description ""');
});

// --- NOT YET TESTABLE

// #TODO(build): empty-string arguments bypass the `== null` guards in both
// #TODO routers, so `zinn task create WIP ""` creates a nameless task. The
// #TODO routers already carry a "do empty strings bypass this check?" TODO.
test.todo("empty-string arguments are rejected", () => {
  runZinn(["project", "create", "Empty", "EMPTY"]);

  expect(runZinn(["task", "create", "EMPTY", ""]).code).toBe(1);
  expect(runZinn(["project", "create", "", ""]).code).toBe(1);
});

// #TODO(build): the `--json` output contract from NOTES.md ("Output contract")
// #TODO is decided but unimplemented. Every assertion above matches substrings
// #TODO of human-readable output, which will break the moment formatting or
// #TODO colors land.
// #TODO Do not assert merely that stdout is JSON-parseable: `console.info` renders
// #TODO a flat string array as `[ "Backlog", ... ]`, which parses by coincidence.
// #TODO Assert the entity shape instead, as below.
test.todo("--json emits machine-readable output on read commands", () => {
  runZinn(["project", "create", "Json", "JSON"]);

  const result = runZinn(["project", "column", "list", "JSON", "--json"]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toBeArray();
  expect(parsed[0]).toMatchObject({ name: "Backlog" });
});

// #TODO(build): the exit-code table from NOTES.md ("Output contract", still
// #TODO open) — distinct nonzero codes for not-found vs invalid-input vs DB
// #TODO error. Everything currently exits 1 via `quit`, so the tests above
// #TODO cannot distinguish "project missing" from "wrong number of args".
test.todo("failure classes have distinct exit codes", () => {
  expect(runZinn(["project", "delete", "NOSUCH"]).code).toBe(4); // ? not found
  expect(runZinn(["project", "create", "OnlyAName"]).code).toBe(2); // ? invalid input
});

// #TODO(refactor): `quit()` calls `process.exit`, so a handler cannot be called
// #TODO in-process without taking the runner down — every case here pays a
// #TODO subprocess spawn for it. NOTES.md records the fix: handlers throw,
// #TODO `index.ts` catches and exits. Then the router/handler layer gets fast
// #TODO in-process unit tests and this file shrinks to a thin smoke suite.
test.todo("handlers throw instead of exiting, so they can be tested in-process", async () => {
  const { projectRouter } = await import("./src/routes/project-router");

  expect(() => projectRouter.create.run([])).toThrow(
    "Both the project name and the project key must be defined",
  );
});
