import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { createEmptyDatabase, runZinn, withIsolatedZinnDir } from "../test-helpers";

// ? Do not assert merely that stdout is JSON-parseable: `console.info` renders
// ? a flat string array as `[ "Backlog", ... ]`, which parses by coincidence.
// ? Assert the entity shape instead.
test("--json emits machine-readable output on read commands", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "JSON", "--name", "Json"], testDir);

    const result = await runZinn(["project", "column", "list", "JSON", "--json"], testDir);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toBeArray();
    expect(parsed[0]).toMatchObject({ name: "Backlog" });
  });
});

test("--json prints the created entity on write commands, wherever the flag is placed", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const project = await runZinn(["project", "create", "--json", "WEB", "--name", "Web"], testDir);
    expect(JSON.parse(project.stdout)).toEqual({ id: expect.any(String), key: "WEB", name: "Web", description: null });

    const created = await runZinn(["task", "create", "WEB", "--title", "Ship it", "--json"], testDir);

    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      id: expect.any(String),
      project_id: expect.any(String),
      column_id: expect.any(String),
      key: "WEB-1",
      status: "Active",
      column: "Backlog",
      is_first: true,
      is_last: false,
      column_category: "backlog",
      title: "Ship it",
      description: null,
      priority: null,
      due_at: null,
      labels: [],
      label_ids: [],
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });
});

test("--json combines a task and its relations into one document on task view", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "API"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "UI"], testDir);
    await runZinn(["task", "relation", "create", "WEB-2", "WEB-1", "--type", "dependency"], testDir);

    const viewed = JSON.parse((await runZinn(["task", "view", "WEB-2", "--json"], testDir)).stdout);

    expect(viewed).toMatchObject({ key: "WEB-2", title: "UI" });
    expect(viewed.relations).toEqual([
      {
        id: expect.any(String),
        type: "dependency",
        direction: "outgoing",
        task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "WEB-1", column: "Backlog", is_first: true, is_last: false, column_category: "backlog", title: "API", status: "Active" },
      },
    ]);
  });
});

test("--json prints an empty array for empty lists, while text output stays empty", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    createEmptyDatabase(testDir);
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("");
    expect(JSON.parse((await runZinn(["project", "list", "--json"], testDir)).stdout)).toEqual([]);
    expect(JSON.parse((await runZinn(["label", "list", "--json"], testDir)).stdout)).toEqual([]);
  });
});

test("--json reports errors as JSON on stderr and leaves stdout empty", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const result = await runZinn(["project", "create", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr);
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(errorDocumentSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.error.code).toBe("invalid_input");
    expect(parsed.error.details.argument).toBe("project-key");
    expect(parsed.error.message).toContain("<project-key>");
    expect(parsed.error.help).toContain("Usage: zinn project create");
  });
});
