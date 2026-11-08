import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";
import { errorDocumentSchema } from "../src/errors";
import { latestVersion, MIGRATIONS } from "../../core/src/migrations/registry";
import { CLI_PATH, createDatabase, databaseSnapshot, runZinn, runZinnWithPipedYes, withIsolatedZinnDir } from "../test-helpers";

const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);

test("a newer database refuses changes, naming both versions and this CLI, while reads still work", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);

    const list = await runZinn(["task", "list", "MIG"], dir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Kept");

    const created = await runZinn(["--json", "task", "create", "MIG", "--title", "Refused"], dir);
    expect(created.code).toBe(1);
    expect(created.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(created.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", databasePath: join(dir, "data", "zinn.sqlite"), schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    for (const fact of ["cli", packageJson.version, CLI_PATH]) {
      expect(JSON.parse(created.stderr).error.message).toContain(fact);
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("task delete on a read-only database refuses before asking for confirmation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinnWithPipedYes(["--json", "task", "delete", "MIG-1"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database" } });
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("an unmarked database is refused, for reads and writes, and left unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    for (const args of [["task", "list", "MIG"], ["task", "create", "MIG", "--title", "Refused"]]) {
      const result = await runZinn(["--json", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0, databasePath: join(dir, "data", "zinn.sqlite") } });
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});
