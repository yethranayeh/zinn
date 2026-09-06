import { test, expect, afterAll } from "bun:test";
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
  const result = runZinn(["task", "delete", "WIP"]);

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

  // #TODO(build): this only proves the command exited cleanly. The actual
  // #TODO "attaches to its project" assertion needs `task list` — see the
  // #TODO `.todo` case directly below.
  expect(result.code).toBe(0);
});

// --- NOT YET TESTABLE

// #TODO(build): `task list` command. Without a read path there is no way to
// #TODO observe a task through the CLI, so nothing downstream of `task create`
// #TODO can be asserted end-to-end.
test.todo("task create attaches a task to its project", () => {
  runZinn(["project", "create", "Alpha", "ALPHA"]);
  runZinn(["project", "create", "Beta", "BETA"]);
  runZinn(["task", "create", "ALPHA", "alpha task"]);

  expect(runZinn(["task", "list", "ALPHA"]).stdout).toContain("alpha task");
  expect(runZinn(["task", "list", "BETA"]).stdout).not.toContain("alpha task");
});

test("project list shows every established project", () => {
  runZinn(["project", "create", "Listed", "LIST"]);

  const result = runZinn(["project", "list"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("LIST");
});

// #TODO(build): `task delete` command. `taskRouter` currently exposes only
// #TODO `create` (packages/cli/src/routes/task-router.ts).
test.todo("task delete removes the task but not its project", () => {
  runZinn(["project", "create", "Keep", "KEEP"]);
  runZinn(["task", "create", "KEEP", "doomed task"]);

  expect(runZinn(["task", "delete", "KEEP", "1"]).code).toBe(0);
  expect(runZinn(["task", "list", "KEEP"]).stdout).not.toContain("doomed task");
  expect(runZinn(["project", "list"]).stdout).toContain("KEEP");
});

// #TODO(fix): `task.create` in packages/core/index.ts increments the project's
// #TODO task counter *before* inserting the task, so a failed insert burns a
// #TODO number permanently. Already flagged inline there; needs the increment
// #TODO and the insert wrapped in one transaction.
test.todo("a failed task create does not burn a task number", () => {
  runZinn(["project", "create", "Counter", "CNT"]);
  runZinn(["task", "create", "CNT", "first task"]);
  runZinn(["task", "create", "CNT", ""]); // ? expected to fail once empty titles are rejected

  runZinn(["task", "create", "CNT", "second task"]);
  expect(runZinn(["task", "list", "CNT"]).stdout).toContain("#2");
});

// #TODO(fix): `task.create` computes `task_order` from `dbTask.getAll()`, which
// #TODO returns tasks across *all* projects (FIXME already noted in
// #TODO packages/core/index.ts). Ordering within one project is therefore
// #TODO influenced by unrelated projects' tasks.
test.todo("task ordering is scoped to a single project", () => {
  runZinn(["project", "create", "One", "ONE"]);
  runZinn(["project", "create", "Two", "TWO"]);

  runZinn(["task", "create", "ONE", "one first"]);
  runZinn(["task", "create", "TWO", "two first"]);
  runZinn(["task", "create", "ONE", "one second"]);

  const listed = runZinn(["task", "list", "ONE"]).stdout;
  expect(listed.indexOf("one first")).toBeLessThan(listed.indexOf("one second"));
  expect(listed).not.toContain("two first");
});

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
