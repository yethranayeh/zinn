import { expect, test } from "bun:test";

import { relationTypeSchema } from "@zinn-dev/core";
import { errorDocumentSchema } from "../src/errors";
import { DIM_SEPARATOR, runZinn, SECTION_RULE, withIsolatedZinnDir } from "../test-helpers";

test("relation commands show directional and symmetric links, including archived cross-project tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("project", "create", "OTHER")).code).toBe(0);
    await run("task", "create", "APP", "--title", "Copy");
    await run("task", "create", "OTHER", "--title", "Original");
    expect((await run("task", "relation", "list", "APP-1")).stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "APP-1", "APP-1", "--type", "related")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["targetTaskKey"] } });
    expect((await run("task", "relation", "create", "APP-1", "OTHER-99", "--type", "related")).code).toBe(1);
    expect((await run("task", "relation", "list", "OTHER-99")).code).toBe(1);
    for (const type of relationTypeSchema.options) {
      const created = await run("task", "relation", "create", "app-1", "OTHER-1", "--type", type);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("APP-1");
      expect(created.stdout).toContain("OTHER-1");
      const outgoing = JSON.parse((await run("task", "relation", "list", "APP-1", "--json")).stdout);
      const incoming = JSON.parse((await run("task", "relation", "list", "OTHER-1", "--json")).stdout);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]).toMatchObject({ type, direction: type === "related" ? null : "outgoing", task: { key: "OTHER-1", title: "Original" } });
      expect(incoming).toHaveLength(1);
      expect(incoming[0]).toMatchObject({ type, direction: type === "related" ? null : "incoming", task: { key: "APP-1", title: "Copy" } });
      if (type === "related") {
        expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "OTHER-1", "APP-1", "--type", "related")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "relation" } });
      }
      expect((await run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", type)).code).toBe(0);
    }
    expect((await run("task", "relation", "create", "APP-1", "OTHER-1", "--type", "subtask")).code).toBe(0);
    await run("task", "archive", "OTHER-1");
    expect((await run("task", "view", "APP-1")).stdout).toMatch(/Parent\s+\| OTHER-1 \| Backlog \| Original \| Archived/);
    const viewed = JSON.parse((await run("task", "view", "APP-1", "--json")).stdout);
    expect(viewed.relations).toContainEqual({
      id: expect.any(String),
      type: "subtask", direction: "outgoing",
      task: { id: expect.any(String), project_id: expect.any(String), column_id: expect.any(String), key: "OTHER-1", column: "Backlog", is_first: true, is_last: false, title: "Original", status: "Archived" },
    });
    expect((await run("task", "create", "APP", "--title", "Child", "--parent", "APP-1")).code).toBe(0);
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "create", "OTHER-1", "APP-2", "--type", "subtask")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "cycle" } });
    expect((await run("task", "relation", "delete", "APP-1", "OTHER-1", "--type", "subtask")).code).toBe(0);
    expect((await run("task", "view", "APP-1")).stdout).not.toContain("Parent");
    expect((await run("task", "relation", "create", "OTHER-1", "APP-1", "--type", "dependency")).code).toBe(0);
  });
});

test("relation list aligns and colors connected columns, and marks archived tasks", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("project", "create", "LONGER");
    await run("task", "create", "APP", "--title", "Copy");
    await run("task", "create", "APP", "--title", "Plan");
    await run("task", "create", "APP", "--title", "Review");
    await run("task", "create", "LONGER", "--title", "Original");
    await run("task", "move", "LONGER-1", "Done");
    expect((await run("project", "column", "create", "APP", "Verification")).code).toBe(0);
    expect((await run("task", "move", "APP-3", "Verification")).code).toBe(0);
    await run("task", "archive", "APP-2");
    await run("task", "relation", "create", "APP-1", "LONGER-1", "--type", "dependency");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-3", "APP-1", "--type", "dependency");

    const expectedLines = [
      "Depends on     | LONGER-1 | Done         | Original",
      "Related to     | APP-2    | Backlog      | Plan | Archived",
      "Depended on by | APP-3    | Verification | Review",
    ];
    const listed = (await run("task", "relation", "list", "APP-1")).stdout;
    expect(listed.trimEnd().split("\n")).toEqual(expectedLines);
    const colored = (await runZinn(["task", "relation", "list", "APP-1"], dir, { FORCE_COLOR: "1" })).stdout;
    expect(colored).toContain("\x1b[32mDone        \x1b[39m");
    expect(colored).toContain("\x1b[90mBacklog     \x1b[39m");
    expect(colored).toContain(`${DIM_SEPARATOR}\x1b[32mVerification\x1b[39m${DIM_SEPARATOR}`);
    expect((await runZinn(["task", "relation", "list", "APP-1"], dir, { NO_COLOR: "1" })).stdout).toBe(listed);
    const json = JSON.parse((await run("task", "relation", "list", "APP-1", "--json")).stdout);
    expect(json.find((entry: { task: { key: string } }) => entry.task.key === "LONGER-1").task.column).toBe("Done");
    expect(json.map((entry: { task: { key: string } }) => entry.task.key)).toEqual(["LONGER-1", "APP-2", "APP-3"]);
    const viewedJson = JSON.parse((await run("task", "view", "APP-1", "--json")).stdout);
    expect(viewedJson.relations).toEqual(json);

    const viewed = (await run("task", "view", "APP-1")).stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nRelations:\n`);
    expect(viewed).toContain(`${expectedLines.join("\n")}\n`);
  });
});

test("relation help and argument errors make types discoverable without prompting", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    for (const args of [
      ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "unknown"],
    ]) {
      const result = await runZinn(["task", "relation", "create", ...args], testDir);
      expect(result.code).toBe(1);
      for (const type of relationTypeSchema.options) {
        expect(result.stderr).toContain(type);
      }
    }
    for (const args of [
      ["APP-1", "--type", "related"],
      ["APP-1", "APP-2", "APP-3", "--type", "related"],
      ["APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
      ["APP-1", "APP-2", "--typo", "related"],
    ]) {
      expect((await runZinn(["task", "relation", "create", ...args], testDir)).code).toBe(1);
    }
    const help = await runZinn(["task", "relation", "create", "--help"], testDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: zinn task relation create");
    expect(help.stdout).toContain("--type");
    for (const type of relationTypeSchema.options) {
      expect(help.stdout).toContain(type);
    }
    expect((await runZinn(["task", "relation", "--help"], testDir)).stdout).toContain("Usage: zinn task relation <command>");
    expect((await runZinn(["task", "relation", "list"], testDir)).code).toBe(1);
    expect((await runZinn(["task", "relation", "list", "APP-1", "APP-2"], testDir)).code).toBe(1);
  });
});

test("relation deletion is usable without a prompt and updates list and view", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "First");
    await run("task", "create", "APP", "--title", "Second");
    await run("task", "create", "APP", "--title", "Third");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-1", "APP-3", "--type", "dependency");
    const removed = await run("task", "relation", "delete", "app-2", "APP-1", "--type", "related");
    expect(removed.code).toBe(0);
    for (const fact of ["related", "APP-2", "APP-1"]) {
      expect(removed.stdout).toContain(fact);
    }
    expect((await run("task", "relation", "list", "APP-1")).stdout).toContain("Depends on");
    expect((await run("task", "view", "APP-2")).stdout).not.toContain("Related to");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "task", "relation", "delete", "APP-1", "APP-2", "--type", "related")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "relation" } });
    for (const args of [[], ["APP-1"], ["APP-1", "APP-2"],
      ["APP-1", "APP-2", "--type", "invalid"],
      ["APP-1", "APP-2", "--type", "related", "--type", "dependency"],
    ]) {
      expect((await run("task", "relation", "delete", ...args)).code).toBe(1);
    }
    expect((await run("task", "relation", "delete", "--help")).stdout).toContain("Usage: zinn task relation delete");
    expect((await run("task", "relation", "--help")).stdout).toContain("Usage: zinn task relation <command>");
  });
});
