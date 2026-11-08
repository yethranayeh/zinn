import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, SECTION_RULE, taskViewContent, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task edit preserves omitted fields and identity, and accepts empty descriptions", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EDIT", "--name", "Edits"], dir);
    await runZinn(["task", "create", "EDIT", "--title", "Original", "--description", "Description"], dir);
    const read = () => withTestDb(dir, (db) =>
      db.query<import("../../core/src/types").Task, []>("SELECT * FROM task").get()!);
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
