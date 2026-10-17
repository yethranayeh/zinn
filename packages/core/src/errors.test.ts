import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";
import { CoreError, InputValidationError } from "./errors.js";
import { resolveSettings } from "./settings.js";
import { validateTaskInput, taskEditSchema } from "./schemas/task.js";
import { checkBackup, RestoreRefusedError } from "./migrations/restore.js";
import { migrateDatabase, MigrationRefusedError } from "./migrations/migrate.js";
import { ReadOnlyDatabaseError, UnmarkedDatabaseError, DEFAULT_OPEN_POLICY } from "./migrations/open-policy.js";
import { createSchema } from "./migrations/runner.js";
import { assertFreeSpace } from "./migrations/space.js";
import { withDirectory } from "./migrations/testing.js";
import { SqliteError } from "./sqlite/database.js";

function caught(action: () => unknown): CoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    return error as CoreError;
  }
  throw new Error("Expected a failure");
}

test("ZINN-282: expected operation failures retain facts and leave all stored rows unchanged", () => {
  withDirectory((directory) => {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { project, column, task, label, relation, comment, activity, backup, reindex, CoreError, TextEditMatchError, SqliteError } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      import { snapshot } from ${JSON.stringify(new URL("./migrations/testing.ts", import.meta.url).pathname)};
      const actor = { kind: "human", name: "Test", email: null };
      for (const action of [() => backup.create({ client: "test", version: "1" }), () => reindex.run()]) {
        assert.throws(action, (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "database" && typeof error.facts.databasePath === "string");
      }
      const app = project.create({ key: "APP" }, actor);
      const other = project.create({ key: "OTHER" }, actor);
      const empty = project.create({ key: "EMPTY" }, actor);
      getDb().query("DELETE FROM project_column WHERE project_id = $id").run({ $id: empty.id });
      for (const title of ["One", "Two", "Three"]) {
        task.create({ project_id: app.id, title, description: "alpha alpha" }, actor);
      }
      task.create({ project_id: other.id, title: "Other" }, actor);
      task.move({ taskKey: "APP-3", targetColumn: "TODO" }, actor);
      task.archive("APP-2", actor);
      label.create({ name: "bug" }, actor);
      label.create({ name: "other" }, actor);
      relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor);

      function failure(action, kind, facts) {
        const before = snapshot(getDb());
        let caught;
        try { action(); } catch (error) { caught = error; }
        assert.ok(caught instanceof CoreError);
        assert.equal(caught.kind, kind);
        for (const [key, value] of Object.entries(facts)) {
          assert.deepEqual(caught.facts[key], value, key);
        }
        assert.deepEqual(snapshot(getDb()), before);
        return caught;
      }
      const missingProject = { entity: "project", key: "MISSING" };
      failure(() => project.create({ key: "APP" }, actor), "conflict", { entity: "project", key: "APP", reason: "already_exists" });
      failure(() => project.edit({ projectKey: "missing", name: "Name" }, actor), "missing", missingProject);
      failure(() => project.delete("MISSING", actor), "missing", missingProject);
      failure(() => column.getAllByProjectKey("missing"), "missing", missingProject);
      failure(() => column.create({ projectKey: "APP", name: "Backlog" }, actor), "conflict", { entity: "column", key: "Backlog", reason: "already_exists" });
      failure(() => column.edit({ projectKey: "APP", columnName: "TODO", name: "Backlog" }, actor), "conflict", { entity: "column", reason: "already_exists" });
      failure(() => label.create({ name: "bug" }, actor), "conflict", { entity: "label", key: "bug", reason: "already_exists" });
      failure(() => label.edit({ labelName: "other", name: "bug" }, actor), "conflict", { entity: "label", reason: "already_exists" });
      failure(() => label.delete({ name: "missing" }, actor), "missing", { entity: "label", key: "missing" });
      failure(() => task.getByKey("bad-key"), "input", { field: ["taskKey"] });
      failure(() => task.getByKey("MISSING-1"), "missing", missingProject);
      failure(() => task.getByKey("APP-999"), "missing", { entity: "task", key: "APP-999" });
      failure(() => comment.getByKey("bad"), "input", { field: ["commentKey"] });
      failure(() => comment.getByKey("bad#1"), "input", { field: ["commentKey"] });
      failure(() => comment.getByKey("APP-1#999"), "missing", { entity: "comment", key: "APP-1#999" });
      failure(() => task.create({ project_id: "missing-id", title: "Missing" }, actor), "missing", { entity: "project", key: "missing-id" });
      failure(() => task.create({ project_id: empty.id, title: "Missing column" }, actor), "conflict", { entity: "project", key: "EMPTY", reason: "no_columns" });
      failure(() => task.getAll({ projectKey: "MISSING" }), "missing", missingProject);
      failure(() => task.search({ query: "alpha", projectKey: "MISSING" }), "missing", missingProject);
      failure(() => task.move({ taskKey: "APP-1", targetColumn: "missing" }, actor), "missing", { entity: "column", key: "missing" });
      failure(() => task.moveMany({ taskKeys: ["APP-1", "APP-2"], targetColumn: "Done" }, actor), "conflict", { entity: "task", key: "APP-2", reason: "archived" });
      failure(() => task.order({ taskKey: "APP-2", direction: "top" }, actor), "conflict", { key: "APP-2", reason: "archived" });
      for (const [targetTaskKey, reason] of [["OTHER-1", "different_project"], ["APP-3", "different_column"], ["APP-2", "archived"]]) {
        failure(() => task.order({ taskKey: "APP-1", direction: "before", targetTaskKey }, actor), "conflict", { reason });
      }
      failure(() => relation.getAll(null), "input", { field: ["taskKey"] });
      failure(() => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-1", relation_type: "related" }, actor), "input", { entity: "relation", field: ["targetTaskKey"] });
      failure(() => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor), "conflict", { entity: "relation", reason: "already_exists" });
      failure(() => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "subtask" }, actor), "conflict", { key: "APP-1", reason: "parent_exists" });
      failure(() => relation.create({ sourceTaskKey: "APP-2", targetTaskKey: "APP-1", relation_type: "subtask" }, actor), "conflict", { reason: "cycle" });
      failure(() => relation.delete({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, actor), "missing", { entity: "relation" });
      failure(() => activity.getById("ffffffff"), "missing", { entity: "activity", key: "ffffffff" });
      getDb().exec("INSERT INTO activity (id, created_at, actor_kind, entity_type, entity_id, action) VALUES ('00000000-0000-7000-8000-000000000001', 0, 'human', 'task', 'one', 'create'), ('00000000-0000-7000-8000-000000000002', 0, 'human', 'task', 'two', 'create')");
      const ambiguous = failure(() => activity.getById("00000000"), "conflict", { reason: "ambiguous_reference", matchCount: 2 });
      assert.equal(ambiguous.facts.candidateIds.length, 2);
      for (const find of ["absent", "alpha"]) {
        const matchCount = find === "absent" ? 0 : 2;
        const error = failure(() => task.edit({ taskKey: "APP-1", description: { find, replace: "replacement" } }, actor), "conflict", { reason: "text_match_count", matchCount, field: ["description"] });
        assert.ok(error instanceof TextEditMatchError);
      }
      const beforeNoop = snapshot(getDb());
      task.move({ taskKey: "APP-1", targetColumn: "Backlog" }, actor);
      task.edit({ taskKey: "APP-1", title: "One" }, actor);
      assert.deepEqual(snapshot(getDb()), beforeNoop);
      getDb().exec("DROP TABLE task_search");
      const search = failure(() => task.search({ query: "alpha" }), "storage", { reason: "missing_index" });
      assert.ok(search.cause instanceof SqliteError);
      failure(() => task.create({ project_id: app.id, title: "Rolled back" }, actor), "storage", { reason: "missing_index" });
      assert.throws(() => getDb().exec("INSERT INTO project (key) VALUES ('APP')"), SqliteError);
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

test("validation and settings preserve safe locations and actual causes", () => {
  const validation = caught(() => validateTaskInput(taskEditSchema, { taskKey: "APP-1", title: 123 }));
  expect(validation).toBeInstanceOf(InputValidationError);
  expect(validation.facts.field).toEqual(["title"]);
  expect((validation as InputValidationError).issues[0]).toMatchObject({ code: "invalid_type", path: ["title"] });
  expect(JSON.stringify(validation)).not.toContain("123");
  withDirectory((directory) => {
    const settingsPath = join(directory, "settings.json");
    const inputs = { home: directory, cwd: directory, env: { ZINN_DIR: directory } };
    writeFileSync(settingsPath, "{");
    const json = caught(() => resolveSettings(inputs));
    expect(json).toMatchObject({ kind: "input", facts: { settingsPath, reason: "invalid_json" } });
    expect(json.cause).toBeInstanceOf(SyntaxError);
    writeFileSync(settingsPath, '{"storage":{"directory":42}}');
    const invalid = caught(() => resolveSettings(inputs));
    expect(invalid).toMatchObject({ kind: "input", facts: { settingsPath, reason: "invalid_settings", field: ["storage", "directory"] } });
    expect(invalid.cause).toMatchObject({ name: "ZodError" });
    mkdirSync(join(directory, "unreadable", "settings.json"), { recursive: true });
    const unreadable = caught(() => resolveSettings({ ...inputs, env: { ZINN_DIR: join(directory, "unreadable") } }));
    expect(unreadable.kind).toBe("storage");
    expect(unreadable.cause).toMatchObject({ code: "EISDIR" });
  });
});

test("administrative refusals distinguish absence, backup policy, corruption and compatibility", () => {
  withDirectory((directory) => {
    const path = join(directory, "backup.sqlite");
    const build = { client: "test", version: "1" };
    const missing = caught(() => checkBackup(path, [], build));
    expect(missing).toBeInstanceOf(RestoreRefusedError);
    expect(missing).toMatchObject({ kind: "missing", facts: { entity: "backup", backupPath: path } });
    const migrationOptions = { backup: { ...build, directory } };
    const absent = caught(() => migrateDatabase(path, migrationOptions));
    expect(absent).toBeInstanceOf(MigrationRefusedError);
    expect(absent).toMatchObject({ kind: "missing", facts: { databasePath: path } });
    const empty = openDatabase(path);
    empty.close();
    expect(caught(() => migrateDatabase(path, migrationOptions)).kind).toBe("missing");
    writeFileSync(path, "not a SQLite database");
    const damaged = caught(() => checkBackup(path, [], build));
    expect(damaged).toMatchObject({ kind: "storage", facts: { backupPath: path, reason: "not_database" } });
    expect(damaged.cause).toBeInstanceOf(SqliteError);
    const dbPath = join(directory, "database.sqlite");
    const db = openDatabase(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    expect(caught(() => checkBackup(dbPath, [], build))).toMatchObject({ kind: "conflict", facts: { reason: "invalid_backup", schemaVersion: 0 } });
    expect(caught(() => migrateDatabase(dbPath, migrationOptions))).toMatchObject({ kind: "conflict", facts: { reason: "unmarked_database", schemaVersion: 0 } });
    const freshPath = join(directory, "fresh.sqlite");
    const fresh = openDatabase(freshPath);
    createSchema(fresh, []);
    fresh.exec("PRAGMA user_version = 2");
    fresh.close();
    expect(caught(() => checkBackup(freshPath, [], build))).toMatchObject({ kind: "conflict", facts: { reason: "newer_database", schemaVersion: 2, supportedSchemaVersion: 1 } });
    expect(caught(() => migrateDatabase(freshPath, { ...migrationOptions, migrations: [] }))).toMatchObject({ kind: "conflict", facts: { reason: "newer_database", schemaVersion: 2, supportedSchemaVersion: 1 } });
    const facts = { databasePath: freshPath, version: 2, latestVersion: 1 };
    for (const reason of ["older", "newer", "unmarked"] as const) {
      const refusal = new ReadOnlyDatabaseError(reason, facts, DEFAULT_OPEN_POLICY);
      expect(refusal.reason).toBe(reason);
      expect(refusal.facts).toMatchObject({ databasePath: freshPath, schemaVersion: 2, supportedSchemaVersion: 1 });
    }
    expect(new UnmarkedDatabaseError(facts).facts).toMatchObject({ databasePath: freshPath, reason: "unmarked_database" });
    const paths = { database: directory, temporary: directory };
    const required = { database: 1, backup: 0, temporary: 1 };
    const unknownSpace = caught(() => assertFreeSpace(paths, required, () => null));
    expect(unknownSpace).toMatchObject({ kind: "storage", facts: { path: directory } });
    expect(unknownSpace.facts.reason).toBeUndefined();
    expect(caught(() => assertFreeSpace(paths, required, () => ({ device: 1, blockBytes: 1, availableBytes: 0 })))).toMatchObject({ kind: "storage", facts: { path: directory, reason: "disk_full" } });
  });
});
