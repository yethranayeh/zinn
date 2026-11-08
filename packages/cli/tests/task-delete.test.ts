import { expect, test } from "bun:test";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { runCliInTerminal } from "../testing";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

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
