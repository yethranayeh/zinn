import { expect, test } from "bun:test";

import { taskPrioritySchema } from "../../core/src/schemas/task";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, taskViewContent, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("priority inputs accept any letter case on create and edit and persist canonical values", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "PRI"], directory)).code).toBe(0);
    for (const priority of [...taskPrioritySchema.options, "none"]) {
      const expectedPriority = priority === "none" ? null : priority;
      const inputs = [
        priority.toUpperCase(),
        priority[0]!.toUpperCase() + priority.slice(1),
        [...priority].map((letter, index) => index % 2 === 0 ? letter : letter.toUpperCase()).join(""),
      ];
      for (const input of inputs) {
        const created = await runZinn(["task", "create", "PRI", "--title", "Case test", "--priority", input, "--json"], directory);
        expect(created.code, created.stderr).toBe(0);
        const taskKey = JSON.parse(created.stdout).key;
        expect(JSON.parse(created.stdout).priority).toBe(expectedPriority);
        const initialPriority = expectedPriority === "high" ? "low" : "high";
        expect((await runZinn(["task", "edit", taskKey, "--priority", initialPriority], directory)).code).toBe(0);
        const edited = await runZinn(["task", "edit", taskKey, "--priority", input, "--json"], directory);
        expect(edited.code, edited.stderr).toBe(0);
        expect(JSON.parse(edited.stdout).priority).toBe(expectedPriority);
        expect(JSON.parse((await runZinn(["task", "view", taskKey, "--json"], directory)).stdout).priority).toBe(expectedPriority);
        withTestDb(directory, (db) => {
          const stored = db.query<{ priority: string | null }, [number]>("SELECT priority FROM task WHERE number = ?").get(Number(taskKey.slice("PRI-".length)))!;
          expect(stored.priority).toBe(expectedPriority);
        });
      }
    }
    const before = (await runZinn(["task", "list", "PRI", "--json"], directory)).stdout;
    for (const args of [
      ["task", "create", "PRI", "--title", "Invalid"],
      ["task", "edit", "PRI-1", "--title", "Invalid"],
    ]) {
      const invalid = await runZinn([...args, "--priority", "CRITICAL", "--json"], directory);
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(invalid.stderr)).error).toMatchObject({
        code: "invalid_input", details: { argument: "--priority" },
      });
    }
    expect((await runZinn(["task", "list", "PRI", "--json"], directory)).stdout).toBe(before);
  });
});

test("priority persists across CLI creation, editing, listing, clearing, and no-op edits", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "PRI"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "PRI", "--title", "Default"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ priority: string | null }, []>("SELECT priority FROM task").get()!.priority).toBeNull();
    });
    for (const [index, priority] of ["low", "medium", "high", "urgent"].entries()) {
      const created = await runZinn(["task", "create", "PRI", "--title", priority, "--priority", priority], directory);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(`| Backlog | ${priority[0]!.toUpperCase()} | ${priority}`);
      const taskKey = `PRI-${index + 2}`;
      const viewed = await runZinn(["task", "view", taskKey], directory);
      expect(taskViewContent(viewed.stdout)).toBe(`${taskKey} | Backlog | ${priority[0]!.toUpperCase()}${priority.slice(1)} | ${priority}\n`);
      expect(JSON.parse((await runZinn(["task", "view", taskKey, "--json"], directory)).stdout).priority).toBe(priority);
    }
    expect((await runZinn(["task", "list", "PRI"], directory)).stdout).toBe(
      [
        `PRI-1 | Backlog | - | Default`,
        `PRI-2 | Backlog | L | low`,
        `PRI-3 | Backlog | M | medium`,
        `PRI-4 | Backlog | H | high`,
        `PRI-5 | Backlog | U | urgent`,
      ].join("\n") + "\n",
    );
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBeGreaterThan(1);
    });
    withTestDb(directory, (db) => db.run("UPDATE task SET updated_at = 1 WHERE number = 1"));
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "high"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      expect(db.query<{ updated_at: number }, []>("SELECT updated_at FROM task WHERE number = 1").get()!.updated_at).toBe(1);
    });
    expect((await runZinn(["task", "edit", "PRI-1", "--title", "Renamed"], directory)).stdout).toBe(
      "PRI-1 | Backlog | H | Renamed\n",
    );
    expect((await runZinn(["task", "list", "PRI"], directory)).stdout).toContain(
      `PRI-1 | Backlog | H | Renamed`,
    );
    expect(taskViewContent((await runZinn(["task", "view", "PRI-1"], directory)).stdout)).toBe("PRI-1 | Backlog | High | Renamed\n");
    expect(JSON.parse((await runZinn(["task", "list", "PRI", "--json"], directory)).stdout)[0].priority).toBe(
      "high",
    );
    const invalid = await runZinn(["task", "edit", "PRI-1", "--title", "Wrong", "--priority", "critical"], directory);
    expect(invalid.code).not.toBe(0);
    expect((await runZinn(["task", "view", "PRI-1"], directory)).stdout).toContain("Renamed");
    expect((await runZinn(["task", "archive", "PRI-1"], directory)).code).toBe(0);
    expect((await runZinn(["task", "edit", "PRI-1", "--priority", "none"], directory)).code).toBe(0);
    withTestDb(directory, (db) => {
      const row = db.query<{ priority: string | null; archived_at: number | null }, []>("SELECT priority, archived_at FROM task WHERE number = 1").get()!;
      expect(row.priority).toBeNull();
      expect(row.archived_at).not.toBeNull();
    });
  });
});
