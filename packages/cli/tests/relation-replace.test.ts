import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";
import { runCliInTerminal } from "../testing";

async function seed(directory: string) {
  for (const args of [
    ["project", "create", "APP"],
    ["task", "create", "APP", "--title", "Child"],
    ["task", "create", "APP", "--title", "Old parent"],
    ["task", "create", "APP", "--title", "New parent"],
  ]) {
    const result = await runZinn(args, directory);
    expect(result.code, result.stderr).toBe(0);
  }
}

function snapshot(directory: string) {
  return withTestDb(directory, (db) => Object.fromEntries(
    ["project", "task", "task_relations", "activity", "task_search"].map((table) =>
      [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  ));
}

test("ZINN-91: JSON creation needs no approval until a relation must be replaced", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await seed(directory);
    const args = ["task", "relation", "create", "APP-1", "APP-2", "--type"];
    const first = await runZinn([...args, "related", "--json"], directory);
    expect(first.code, first.stderr).toBe(0);
    const original = resultSchemas.RelationChange.parse(JSON.parse(first.stdout));
    const before = snapshot(directory);
    for (const flags of [[], ["--json"]]) {
      const refused = await runZinn([...args, "dependency", ...flags], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--yes");
      if (flags.includes("--json")) {
        expect(errorDocumentSchema.parse(JSON.parse(refused.stderr)).error).toMatchObject({
          code: "invalid_input", details: { reason: "confirmation_required", argument: "--yes" },
        });
      }
      expect(snapshot(directory)).toEqual(before);
    }
    const replacement = await runZinn([...args, "dependency", "--yes", "--json"], directory);
    expect(replacement.code, replacement.stderr).toBe(0);
    expect(replacement.stderr).toBe("");
    const created = resultSchemas.RelationChange.parse(JSON.parse(replacement.stdout));
    expect(created).toEqual({ ...original, id: expect.any(String), type: "dependency" });
    expect(created.id).not.toBe(original.id);
    const after = snapshot(directory);
    const repeated = await runZinn([...args, "dependency", "--yes", "--json"], directory);
    expect(repeated.code).toBe(1);
    expect(repeated.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(repeated.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "already_exists", entity: "relation" },
    });
    expect(snapshot(directory)).toEqual(after);
    const listed = JSON.parse((await runZinn(["task", "relation", "list", "APP-1", "--json"], directory)).stdout);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, type: "dependency", direction: "outgoing", task: { key: "APP-2" } });
    const deletion = await runZinn(["task", "relation", "delete", "APP-1", "APP-2", "--type", "dependency", "--yes", "--json"], directory);
    expect(deletion.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(deletion.stderr)).error).toMatchObject({ code: "invalid_input", details: { argument: "--yes" } });
    expect(snapshot(directory)).toEqual(after);
  });
});

test.serial("one terminal confirmation covers the old parent and the conflicting link to the new parent", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await seed(directory);
    for (const [target, type] of [["APP-2", "subtask"], ["APP-3", "related"]]) {
      expect((await runZinn(["task", "relation", "create", "APP-1", target!, "--type", type!], directory)).code).toBe(0);
    }
    const args = ["task", "relation", "create", "APP-1", "APP-3", "--type", "subtask"];
    const before = snapshot(directory);
    const stderrPath = join(directory, "confirmation.stderr");
    const options = { env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory }, cwd: directory, stderrPath };
    for (const input of ["n\n", "\n", "\x04"]) {
      const declined = await runCliInTerminal(args, { ...options, input });
      expect(declined.code).toBe(0);
      const prompt = readFileSync(stderrPath, "utf8");
      for (const key of ["APP-1", "APP-2", "APP-3"]) {
        expect(prompt).toContain(key);
      }
      expect(prompt.match(/\[y\/N\]/g)).toHaveLength(1);
      expect(snapshot(directory)).toEqual(before);
    }
    const interrupted = await runCliInTerminal(args, {
      env: options.env, cwd: directory, input: "\x03", inputWhen: "[y/N]",
    });
    expect(interrupted.code).toBe(130);
    expect(snapshot(directory)).toEqual(before);
    const accepted = await runCliInTerminal(args, { ...options, input: "Y\n" });
    expect(accepted.code, accepted.output).toBe(0);
    expect(readFileSync(stderrPath, "utf8").match(/\[y\/N\]/g)).toHaveLength(1);
    const links = JSON.parse((await runZinn(["task", "relation", "list", "APP-1", "--json"], directory)).stdout);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ type: "subtask", direction: "outgoing", task: { key: "APP-3" } });
  });
});

test.serial("a real competing CLI write during confirmation produces a visible failure without removing the new link", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await seed(directory);
    const args = ["task", "relation", "create", "APP-1", "APP-2", "--type"];
    expect((await runZinn([...args, "related"], directory)).code).toBe(0);
    let afterOtherWriter: ReturnType<typeof snapshot> | undefined;
    const result = await runCliInTerminal([...args, "dependency"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory }, cwd: directory,
      input: "y\n", inputWhen: "[y/N]",
      beforeInput: async () => {
        const competing = await runZinn([...args, "duplicate", "--yes"], directory);
        expect(competing.code, competing.stderr).toBe(0);
        afterOtherWriter = snapshot(directory);
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("relations");
    expect(result.output).toMatch(/changed/i);
    expect(result.output).toMatch(/again/i);
    expect(afterOtherWriter).toBeDefined();
    expect(snapshot(directory)).toEqual(afterOtherWriter!);
    const links = JSON.parse((await runZinn(["task", "relation", "list", "APP-1", "--json"], directory)).stdout);
    expect(links[0].type).toBe("duplicate");
  });
});

test("invalid replacements fail before requesting confirmation and preserve data", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await seed(directory);
    for (const [source, target] of [["APP-1", "APP-2"], ["APP-2", "APP-3"]]) {
      expect((await runZinn(["task", "relation", "create", source!, target!, "--type", "subtask"], directory)).code).toBe(0);
    }
    expect((await runZinn(["task", "relation", "create", "APP-1", "APP-3", "--type", "related"], directory)).code).toBe(0);
    const before = snapshot(directory);
    for (const flags of [[], ["--yes"]]) {
      const result = await runZinn(["task", "relation", "create", "APP-3", "APP-1", "--type", "subtask", "--json", ...flags], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "cycle" } });
      expect(snapshot(directory)).toEqual(before);
    }
  });
});

test("conflicting task-create flags reject aliases of the same target and preserve its number and history", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await seed(directory);
    const before = snapshot(directory);
    for (const flags of [
      ["--depends-on", "APP-1", "--related", "app-1"],
      ["--parent", "APP-1", "--depends-on", "app-1"],
    ]) {
      const result = await runZinn(["task", "create", "APP", "--title", "Conflicting", ...flags, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details: { entity: "relation", key: "APP-1", field: ["relations"] } });
      expect(snapshot(directory)).toEqual(before);
    }
    const created = await runZinn(["task", "create", "APP", "--title", "Next", "--json"], directory);
    expect(JSON.parse(created.stdout).key).toBe("APP-4");
  });
});
