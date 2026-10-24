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
    ["project", "create", "OTHER"],
    ["label", "create", "bug"],
    ["task", "create", "APP", "--title", "First", "--label", "bug"],
    ["task", "create", "APP", "--title", "Survivor"],
    ["task", "create", "OTHER", "--title", "Second"],
    ["task", "comment", "create", "APP-1", "--text", "Comment"],
    ["task", "relation", "create", "APP-1", "APP-2", "--type", "related"],
    ["task", "relation", "create", "APP-1", "OTHER-1", "--type", "dependency"],
    ["task", "archive", "OTHER-1"],
  ]) {
    const result = await runZinn(args, directory);
    expect(result.code, result.stderr).toBe(0);
  }
}

function snapshot(directory: string) {
  return withTestDb(directory, db => Object.fromEntries([
    "task", "task_relations", "task_label", "comment", "label", "activity", "task_search",
  ].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

test("bulk task delete accepts cross-project archived tasks and preserves pre-deletion JSON and labels", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async directory => {
      await seed(directory);
      const listed = await runZinn(["task", "list", "--all", "--json"], directory);
      expect(listed.code).toBe(0);
      const before = JSON.parse(listed.stdout);
      const expected = ["APP-1", "OTHER-1"].map(key => before.find((entry: { key: string }) => entry.key === key));
      const deleted = await runZinn(["task", "delete", "app-1", "OTHER-1", "--yes", ...(json ? ["--json"] : [])], directory);
      expect(deleted.code, deleted.stderr).toBe(0);
      expect(deleted.stderr).toBe("");
      if (json) {
        const entries = JSON.parse(deleted.stdout);
        expect(entries).toEqual(expected);
        resultSchemas.TaskList.parse(entries);
        expect(entries.every((entry: object) => !("changed" in entry))).toBe(true);
      } else {
        const rows = deleted.stdout.trimEnd().split("\n");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatch(/^Deleted APP-1\s+\|/);
        expect(rows[1]).toMatch(/^Deleted OTHER-1\s+\|/);
        expect(rows[0]).toContain("First");
        expect(rows[0]).toContain("bug");
        expect(rows[1]).toContain("Second");
        expect(rows[0]!.indexOf("|")).toBe(rows[1]!.indexOf("|"));
      }
      const remaining = await runZinn(["task", "list", "--all", "--json"], directory);
      expect(JSON.parse(remaining.stdout).map((entry: { key: string }) => entry.key)).toEqual(["APP-2"]);
      const single = await runZinn(["task", "delete", "APP-2", "--yes", "--json"], directory);
      expect(single.code).toBe(0);
      resultSchemas.Task.parse(JSON.parse(single.stdout));
      expect(JSON.parse(single.stdout)).toEqual(before.find((entry: { key: string }) => entry.key === "APP-2"));
    });
  }
});

test("bulk task delete refuses missing and repeated keys before requesting confirmation", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    const before = snapshot(directory);
    for (const keys of [
      ["APP-1", "APP-99"],
      ["APP-1", "MISSING-1"],
      ["APP-1", "invalid-key"],
      ["APP-1", "APP-1"],
      ["app-1", "OTHER-1", "APP-1"],
    ]) {
      for (const flags of [[], ["--json"], ["--yes", "--json"]]) {
        const result = await runZinn(["task", "delete", ...keys, ...flags], directory);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        const missingKey = keys.at(-1)!;
        expect(result.stderr).toContain(missingKey === "MISSING-1" ? "MISSING" : missingKey);
        expect(result.stderr).not.toContain("[y/N]");
        if (flags.includes("--json")) {
          const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
          expect(failure.code).toBe(keys.at(-1) === "APP-99" || keys.at(-1) === "MISSING-1" ? "not_found" : "invalid_input");
          expect(failure.details?.reason).not.toBe("confirmation_required");
        } else {
          expect(result.stderr).not.toContain("--yes");
        }
        expect(snapshot(directory)).toEqual(before);
      }
    }
  });
});

test("bulk task delete requires --yes in JSON and without a terminal", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    const before = snapshot(directory);
    for (const flags of [[], ["--json"]]) {
      const result = await runZinn(["task", "delete", "APP-1", "OTHER-1", ...flags], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--yes");
      expect(snapshot(directory)).toEqual(before);
    }
  });
});

test.serial("bulk task delete asks once for every key and preserves data on decline, EOF and interruption", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    const before = snapshot(directory);
    const args = ["task", "delete", "app-1", "OTHER-1"];
    const options = { env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory }, cwd: directory };
    const stderrPath = join(directory, "confirmation.stderr");
    for (const input of ["n\n", "\n", "\x04"]) {
      const result = await runCliInTerminal(args, { ...options, input, stderrPath });
      expect(result.code).toBe(0);
      const prompt = readFileSync(stderrPath, "utf8");
      expect(prompt).toContain("APP-1");
      expect(prompt).toContain("OTHER-1");
      expect(prompt.match(/\[y\/N\]/g)).toHaveLength(1);
      expect(snapshot(directory)).toEqual(before);
    }
    const interrupted = await runCliInTerminal(args, { ...options, input: "\x03", inputWhen: "[y/N]" });
    expect(interrupted.code).toBe(130);
    expect(snapshot(directory)).toEqual(before);
    const accepted = await runCliInTerminal(args, { ...options, input: "Y\n", stderrPath });
    expect(accepted.code).toBe(0);
    expect(readFileSync(stderrPath, "utf8").match(/\[y\/N\]/g)).toHaveLength(1);
    expect(snapshot(directory).task).toHaveLength(1);
  });
});

