import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { runCliInTerminal } from "../testing";
import { backupFiles, runZinn, runZinnWithPipedYes, withIsolatedZinnDir, withTestDb } from "../test-helpers";

// ? A database with something for each confirming command to change. Returns a backup taken before "Later" was added.
async function seedConfirmationDatabase(dir: string) {
  await runZinn(["project", "create", "CONF"], dir);
  await runZinn(["label", "create", "bug"], dir);
  await runZinn(["task", "create", "CONF", "--title", "Kept", "--label", "bug"], dir);
  await runZinn(["task", "comment", "create", "CONF-1", "--text", "Note"], dir);
  const backupPath = (JSON.parse((await runZinn(["backup", "--json"], dir)).stdout) as { path: string }).path;
  await runZinn(["task", "create", "CONF", "--title", "Later"], dir);

  return backupPath;
}

function confirmationSnapshot(dir: string) {
  const tables = withTestDb(dir, (db) =>
    ["project", "task", "comment", "label", "task_label", "activity"].map((table) =>
      db.query(`SELECT * FROM ${table}`).all(),
    ),
  );

  return { tables, backups: backupFiles(dir) };
}

const runJson = async (dir: string, ...args: Array<string>) => JSON.parse((await runZinn([...args, "--json"], dir)).stdout);

// ? ZINN-143: every command that asks for confirmation, run against seedConfirmationDatabase,
// ? with a check that its change happened.
const CONFIRMING_COMMANDS = [
  {
    argsFor: (_backupPath: string) => ["project", "column", "delete", "CONF", "Review"],
    isDone: async (dir: string) => !(await runJson(dir, "project", "column", "list", "CONF"))
      .some((entry: { name: string }) => entry.name === "Review"),
  },
  {
    argsFor: (_backupPath: string) => ["project", "delete", "CONF"],
    isDone: async (dir: string) => (await runJson(dir, "project", "list")).length === 0,
  },
  {
    argsFor: (_backupPath: string) => ["task", "delete", "CONF-1"],
    isDone: async (dir: string) => (await runZinn(["task", "view", "CONF-1"], dir)).code === 1,
  },
  {
    argsFor: (_backupPath: string) => ["task", "comment", "delete", "CONF-1#1"],
    isDone: async (dir: string) => (await runJson(dir, "task", "view", "CONF-1")).comments.length === 0,
  },
  {
    argsFor: (_backupPath: string) => ["label", "delete", "bug"],
    isDone: async (dir: string) => (await runJson(dir, "label", "list")).length === 0,
  },
  {
    argsFor: (backupPath: string) => ["restore", backupPath],
    isDone: async (dir: string) => (await runJson(dir, "task", "list", "CONF")).length === 1,
  },
];

test("confirming commands without --yes refuse when not in a terminal, and --yes still performs them", async () => {
  for (const { argsFor, isDone } of CONFIRMING_COMMANDS) {
    await withIsolatedZinnDir(async (dir) => {
      const args = argsFor(await seedConfirmationDatabase(dir));
      const before = confirmationSnapshot(dir);

      for (const refused of [await runZinn(args, dir), await runZinnWithPipedYes(args, dir)]) {
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("--yes");
        expect(confirmationSnapshot(dir)).toEqual(before);
      }

      const jsonRefused = await runZinn([...args, "--json"], dir);
      expect(jsonRefused.code).toBe(1);
      expect(jsonRefused.stdout).toBe("");
      expect(JSON.parse(jsonRefused.stderr).error.message).toContain("--yes");
      expect(confirmationSnapshot(dir)).toEqual(before);

      const confirmed = await runZinn([...args, "--yes"], dir);
      expect(confirmed.code).toBe(0);
      expect(await isDone(dir)).toBe(true);
    });
  }
});

test.serial("confirming commands in a terminal act on y and cancel on n with exit code 0", async () => {
  for (const { argsFor, isDone } of CONFIRMING_COMMANDS) {
    await withIsolatedZinnDir(async (dir) => {
      const args = argsFor(await seedConfirmationDatabase(dir));
      const env = { ...TEST_ENVIRONMENT, ZINN_DIR: dir };
      const before = confirmationSnapshot(dir);

      for (const input of ["n\n", "\n"]) {
        const declined = await runCliInTerminal(args, { env, cwd: dir, input });
        expect(declined.code).toBe(0);
        expect(confirmationSnapshot(dir)).toEqual(before);
      }

      const accepted = await runCliInTerminal(args, { env, cwd: dir, input: "y\n" });
      expect(accepted.code).toBe(0);
      expect(await isDone(dir)).toBe(true);
    });
  }
});

test.serial("confirmation prompts use stderr, preserve exact affirmative answers, and decline EOF", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedConfirmationDatabase(dir);
    const before = confirmationSnapshot(dir);
    const stderrPath = join(dir, "prompt.stderr");
    const options = { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, stderrPath };

    for (const input of ["yes\n", " y \n", "\x04"]) {
      const result = await runCliInTerminal(["task", "delete", "CONF-1"], { ...options, input });
      expect(result.code).toBe(0);
      expect(result.output).not.toContain("[y/N]");
      const stderr = readFileSync(stderrPath, "utf8");
      expect(stderr).toContain("CONF-1");
      expect(stderr).toContain("[y/N]");
      expect(stderr).toEndWith("\n");
      expect(confirmationSnapshot(dir)).toEqual(before);
    }

    const accepted = await runCliInTerminal(["task", "delete", "CONF-1"], { ...options, input: "Y\n" });
    expect(accepted.code).toBe(0);
    expect(accepted.output).not.toContain("[y/N]");
    expect((await runZinn(["task", "view", "CONF-1"], dir)).code).toBe(1);
  });
});

test.serial("interrupting a confirmation exits 130 and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await seedConfirmationDatabase(dir);
    const before = confirmationSnapshot(dir);
    const result = await runCliInTerminal(["task", "delete", "CONF-1"], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "\x03", inputWhen: "[y/N]",
    });
    expect(result.code).toBe(130);
    expect(confirmationSnapshot(dir)).toEqual(before);
  });
});

test("--json refuses commands that ask for confirmation without --yes, deleting nothing", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);

    const result = await runZinnWithPipedYes(["project", "delete", "WEB", "--json"], testDir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--yes", reason: "confirmation_required" },
    });
    expect((await runZinn(["project", "list"], testDir)).stdout).toBe("WEB | WEB | 0 active | 0 archived\n");
  });
});

test("--yes deletes without asking for confirmation", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "WEB"], testDir);
    await runZinn(["task", "create", "WEB", "--title", "Ship it"], testDir);

    const result = await runZinn(["task", "delete", "WEB-1", "--yes"], testDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WEB-1 | Backlog | - | Ship it");
    expect((await runZinn(["task", "list", "WEB"], testDir)).stdout).toBe("");
  });
});

test("delete commands with --yes and --json print the deleted entity", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    const run = (...args: Array<string>) => runZinn(args, testDir);
    const deleteJson = async (...args: Array<string>) => {
      const result = await run(...args, "--yes", "--json");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };

    await run("project", "create", "WEB", "--name", "Web");
    await run("project", "create", "GONE", "--name", "Gone");
    await run("task", "create", "WEB", "--title", "Ship it");
    await run("task", "create", "WEB", "--title", "Keep it");
    await run("task", "comment", "create", "WEB-2", "--text", "Looks good");
    await run("label", "create", "urgent", "--color", "red", "--description", "Needs attention soon");

    expect(await deleteJson("task", "delete", "WEB-1")).toEqual({
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
    expect(JSON.parse((await run("task", "list", "WEB", "--json")).stdout)).toMatchObject([
      { key: "WEB-2" },
    ]);

    const deletedComment = await deleteJson("task", "comment", "delete", "WEB-2#1");
    expect(deletedComment).toEqual({
      id: expect.any(String),
      task_id: expect.any(String),
      key: "WEB-2#1",
      text: "Looks good",
      created_at: deletedComment.created_at,
      updated_at: deletedComment.updated_at,
    });
    expect(JSON.parse((await run("task", "comment", "list", "WEB-2", "--json")).stdout)).toEqual([]);

    expect(await deleteJson("label", "delete", "urgent")).toEqual({
      id: expect.any(String),
      name: "urgent",
      color: "red",
      description: "Needs attention soon",
    });
    expect(JSON.parse((await run("label", "list", "--json")).stdout)).toEqual([]);

    expect(await deleteJson("project", "delete", "GONE")).toEqual({ id: expect.any(String), key: "GONE", name: "Gone", description: null });
    expect(JSON.parse((await run("project", "list", "--json")).stdout)).toEqual([
      { id: expect.any(String), key: "WEB", name: "Web", description: null, taskCounts: { active: 1, archived: 0 } },
    ]);
  });
});
