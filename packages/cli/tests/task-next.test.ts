import { expect, test } from "bun:test";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

test("task next reports an empty answer with exit 0 and JSON null", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);

    const text = await runZinn(["task", "next", "APP"], testDir);
    const json = await runZinn(["--json", "task", "next", "APP"], testDir);

    expect(text.code).toBe(0);
    expect(text.stdout.trim().split("\n")).toHaveLength(1);
    expect(text.stdout).not.toContain("APP-");
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toBeNull();
  });
});

test("task next prints the ready task as a task row and JSON task", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);
    await runZinn(["task", "create", "APP", "--title", "Blocked", "--priority", "urgent"], testDir);
    await runZinn(["task", "create", "APP", "--title", "Ready", "--column", "TODO"], testDir);
    await runZinn(["task", "relation", "create", "APP-1", "APP-2", "--type", "dependency"], testDir);

    const text = await runZinn(["task", "next", "APP"], testDir);
    const json = await runZinn(["--json", "task", "next", "APP", "--column", "todo"], testDir);

    expect(text.code).toBe(0);
    expect(text.stdout).toContain("APP-2");
    expect(text.stdout).toContain("Ready");
    expect(json.code).toBe(0);
    expect(resultSchemas.NextTask.parse(JSON.parse(json.stdout))).toMatchObject({
      key: "APP-2",
      title: "Ready",
    });
  });
});

test("task next uses defaultProject unless --all-projects is given", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);
    await runZinn(["project", "create", "OTHER"], testDir);
    await runZinn(["task", "create", "APP", "--title", "App task", "--priority", "low"], testDir);
    await runZinn(["task", "create", "OTHER", "--title", "Other task", "--priority", "high"], testDir);
    await Bun.write(join(testDir, "settings.json"), JSON.stringify({ defaultProject: "APP" }));

    const nextKey = async (args: Array<string>) => {
      const result = await runZinn(["--json", "task", "next", ...args], testDir);
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout).key;
    };

    expect(await nextKey([])).toBe("APP-1");
    expect(await nextKey(["OTHER"])).toBe("OTHER-1");
    expect(await nextKey(["--all-projects"])).toBe("OTHER-1");

    const combined = await runZinn(["--json", "task", "next", "APP", "--all-projects"], testDir);
    expect(combined.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(combined.stderr)).error.code).toBe("invalid_input");
  });
});

test("task next fails for an unknown project", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "APP"], testDir);

    const result = await runZinn(["--json", "task", "next", "NOPE"], testDir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({
      code: "not_found",
      details: { entity: "project", key: "NOPE" },
    });
  });
});
