import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

test("task move, archive and unarchive align several tasks and note repeated keys", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "A"], testDir);
    await runZinn(["project", "create", "LONG"], testDir);
    await runZinn(["task", "create", "A", "--title", "short key"], testDir);
    await runZinn(["task", "create", "LONG", "--title", "long key"], testDir);

    const moved = await runZinn(["task", "move", "A-1", "LONG-1", "A-1", "Done"], testDir);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toBe(
      "A-1    | Done | - | short key\nLONG-1 | Done | - | long key\nA-1    | Done | - | short key\n",
    );
    expect(moved.stderr).toContain("A-1");
    expect(moved.stderr).toContain("Done");

    const archived = await runZinn(["task", "archive", "A-1", "LONG-1", "A-1"], testDir);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toBe(
      "A-1    | Archived | Done | - | short key\nLONG-1 | Archived | Done | - | long key\nA-1    | Archived | Done | - | short key\n",
    );
    expect(archived.stderr).toContain("A-1");

    const unarchived = await runZinn(["task", "unarchive", "LONG-1", "A-1", "LONG-1"], testDir);
    expect(unarchived.code).toBe(0);
    expect(unarchived.stdout).toBe(
      "LONG-1 | Active | Done | - | long key\nA-1    | Active | Done | - | short key\nLONG-1 | Active | Done | - | long key\n",
    );
    expect(unarchived.stderr).toContain("LONG-1");
  });
});

test("task move, archive and unarchive change nothing when any task fails", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "ATOM"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "active"], testDir);
    await runZinn(["task", "create", "ATOM", "--title", "archived"], testDir);
    await runZinn(["task", "archive", "ATOM-2"], testDir);
    const before = (await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout;

    const move = await runZinn(["--json", "task", "move", "ATOM-1", "ATOM-2", "Done"], testDir);
    expect(move.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(move.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "archived", entity: "task", key: "ATOM-2" } });

    const archive = await runZinn(["--json", "task", "archive", "ATOM-1", "ATOM-404"], testDir);
    expect(archive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(archive.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: "ATOM-404" } });

    const unarchive = await runZinn(["--json", "task", "unarchive", "ATOM-2", "nope"], testDir);
    expect(unarchive.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(unarchive.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["taskKey"] } });

    expect((await runZinn(["task", "list", "ATOM", "--all", "--json"], testDir)).stdout).toBe(before);
  });
});

test("task move, archive and unarchive print an object for one task and an array for several with --json", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "SHAPE"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "one"], testDir);
    await runZinn(["task", "create", "SHAPE", "--title", "two"], testDir);

    const moveOne = JSON.parse((await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout);
    expect(moveOne).toMatchObject({ key: "SHAPE-1", column: "Done", changed: true });

    const moveUnchanged = JSON.parse(
      (await runZinn(["task", "move", "SHAPE-1", "Done", "--json"], testDir)).stdout,
    );
    expect(moveUnchanged).toMatchObject({ key: "SHAPE-1", column: "Done", changed: false });

    const archiveMany = JSON.parse(
      (await runZinn(["task", "archive", "SHAPE-1", "SHAPE-2", "SHAPE-1", "--json"], testDir)).stdout,
    );
    expect(archiveMany).toMatchObject([
      { key: "SHAPE-1", status: "Archived", changed: true },
      { key: "SHAPE-2", status: "Archived", changed: true },
      { key: "SHAPE-1", status: "Archived", changed: false },
    ]);

    const unarchiveOne = JSON.parse(
      (await runZinn(["task", "unarchive", "SHAPE-2", "--json"], testDir)).stdout,
    );
    expect(unarchiveOne).toMatchObject({ key: "SHAPE-2", status: "Active", changed: true });
  });
});
