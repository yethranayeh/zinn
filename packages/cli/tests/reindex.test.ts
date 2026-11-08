import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { createDatabase, databaseSnapshot, runZinn, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "../test-helpers";

test("reindex rebuilds a missing search index from the tasks and comments, archived ones included", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Gadget export"], dir);
    await runZinn(["task", "comment", "create", "IDX-1", "--text", "Needs a spinner"], dir);
    await runZinn(["task", "archive", "IDX-2"], dir);
    const before = databaseSnapshot(dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));

    expect((await runZinn(["task", "search", "spinner"], dir)).code).toBe(1);

    const result = await runZinn(["reindex", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(realpathSync(dir), "data", "zinn.sqlite"),
      taskCount: 2,
    });
    expect((await runZinn(["task", "search", "spinner"], dir)).stdout).toContain("IDX-1");
    expect((await runZinn(["task", "search", "gadget", "--archived"], dir)).stdout).toContain("IDX-2");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    expect((await runZinn(["reindex"], dir)).stdout).toContain("2");
  });
});

test("a missing search index points search and index-updating writes at reindex, changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));
    const countRows = () =>
      withTestDb(dir, (db) =>
        db.query("SELECT (SELECT COUNT(*) FROM comment) AS comments, (SELECT COUNT(*) FROM activity) AS activities").get(),
      );
    const before = { snapshot: databaseSnapshot(dir), rows: countRows() };

    for (const args of [
      ["task", "search", "widget"],
      ["task", "create", "IDX", "--title", "Refused"],
      ["task", "comment", "create", "IDX-1", "--text", "Refused"],
    ]) {
      const plain = await runZinn(args, dir);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("task_search");
      expect(plain.stderr).toContain("zinn reindex");

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error).toMatchObject({ code: "storage", details: { reason: "missing_index" } });
      expect(JSON.parse(json.stderr).error.message).toContain("task_search");
      expect(JSON.parse(json.stderr).error.message).toContain("zinn reindex");
    }
    expect({ snapshot: databaseSnapshot(dir), rows: countRows() }).toEqual(before);
  });
});

test("a missing table other than the search index gets no reindex hint", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_label; DROP TABLE label"));
    const result = await runZinn(["label", "list"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("label");
    expect(result.stderr).not.toContain("reindex");
  });
});

test("reindex refuses when there is no database and creates only telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

test("reindex refuses an empty database file and leaves it empty", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
  });
});

test("reindex refuses a newer database and leaves it unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9 } });

    expect(databaseSnapshot(dir)).toEqual(before);
  });
});
