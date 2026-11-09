import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { column, project, task } from "../index";
import { resolveDatabasePath } from "./database-path";
import { resetDatabaseForTests } from "./db";
import { withTestStore } from "./testing";
import { openDatabase } from "./sqlite/bun";
import { withDatabaseInspection } from "./migrations/classify";
import { latestVersion, MIGRATIONS } from "./migrations/registry";

test("column inspection reads names and requested task identities without initialization or migration", () => {
  withTestStore(directory => {
    const actor = { name: "Test", email: null, kind: "human" as const };
    const app = project.create({ key: "APP" }, actor);
    project.create({ key: "OTHER" }, actor);
    task.create({ project_id: app.id, title: "First" }, actor);
    resetDatabaseForTests();
    const path = join(directory, "data", "zinn.sqlite");
    const resolvedPath = resolveDatabasePath(path);
    const snapshot = () => withDatabaseInspection(resolvedPath, db => ({
      version: db.query("PRAGMA user_version").get(),
      schema: db.query("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
      projects: db.query("SELECT * FROM project ORDER BY id").all(),
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const latest = latestVersion(MIGRATIONS);
    for (const version of [latest, latest - 1, latest + 1, 0]) {
      const fixture = openDatabase(path);
      fixture.exec(`PRAGMA user_version = ${version}`);
      fixture.close();
      const before = snapshot();
      for (const allowsLegacyRead of [false, true]) {
        const context = column.inspect({ taskKeys: ["app-1", "APP-99", "In"], allowsLegacyRead });
        if (version === 0 && !allowsLegacyRead) {
          assert.equal(context, null);
        } else {
          assert.deepEqual(context?.taskKeys, ["APP-1"]);
          assert.deepEqual(context?.projects.map(entry => entry.key), ["APP", "OTHER"]);
          assert.ok(context?.projects.every(entry => entry.columns.includes("Doing")));
        }
        assert.deepEqual(snapshot(), before);
      }
    }
  });
});

test("column inspection creates no absent storage and leaves empty or invalid files untouched", () => {
  withTestStore(directory => {
    const dataDirectory = join(directory, "data");
    const path = join(dataDirectory, "zinn.sqlite");
    assert.throws(() => column.inspect());
    assert.equal(existsSync(dataDirectory), false);
    mkdirSync(dataDirectory);
    writeFileSync(path, "");
    assert.equal(column.inspect(), null);
    assert.equal(readFileSync(path).length, 0);
    writeFileSync(path, "not a database");
    assert.throws(() => column.inspect());
    assert.equal(readFileSync(path, "utf8"), "not a database");
  });
});
