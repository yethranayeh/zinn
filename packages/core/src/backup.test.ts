import { Database } from "bun:sqlite";
import { setSystemTime, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup, comment, CoreError, project, RestoreRefusedError, task } from "../index";
import { getStorage } from "./storage";
import { getDb } from "./db";
import { latestVersion, MIGRATIONS } from "./migrations/registry";
import { withTestStore } from "./testing";

test("same-time backups preserve earlier snapshots and include uncheckpointed WAL writes", () => {
  try {
    withTestStore(() => {

      const { backupDirectory, databasePath } = getStorage();
      setSystemTime(new Date("2026-10-03T12:30:05Z"));
      const db = getDb({ createsDatabase: true });
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("CREATE TABLE backup_test (value INTEGER)");
      db.exec("INSERT INTO backup_test VALUES (0)");
      const input = { client: "test", version: "1.2.3" };
      const first = backup.create(input).path;
      const firstBytes = readFileSync(first);
      const paths = new Set([first]);

      for (let value = 1; value <= 20; value++) {
        db.query("UPDATE backup_test SET value = ?").run(value);
        assert.ok(existsSync(databasePath + "-wal"));
        const { path } = backup.create(input);
        assert.ok(basename(path).startsWith("2026-10-03T12-30-05Z-test-1.2.3-"));
        assert.match(basename(path), /-[0-9a-f]{8}\.sqlite$/);
        assert.ok(!paths.has(path));
        paths.add(path);
        const snapshot = new Database(path, { readonly: true });
        try {
          assert.deepEqual(snapshot.query("SELECT value FROM backup_test").get(), { value });
          assert.deepEqual(snapshot.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
        } finally {
          snapshot.close();
        }
      }

      assert.deepEqual(readdirSync(backupDirectory).sort(), [...paths].map((path) => basename(path)).sort());
      assert.deepEqual(readFileSync(first), firstBytes);
      const original = new Database(first, { readonly: true });
      try {
        assert.deepEqual(original.query("SELECT value FROM backup_test").get(), { value: 0 });
        assert.deepEqual(original.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
      } finally {
        original.close();
        db.close();
      }

    });
  } finally { setSystemTime(); }
});

test("backup refuses a dangling backups link, naming the folder and creating nothing", () => {
  withTestStore((directory) => {
    const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
    project.create({ key: "APP" }, human);
    symlinkSync(join(directory, "missing"), join(directory, "backups"), "dir");

    assert.throws(
      () => backup.create({ client: "test", version: "1.2.3" }),
      (error: unknown) => {
        assert.ok(error instanceof CoreError);
        assert.equal(error.kind, "storage");
        assert.deepEqual(error.facts, {
          entity: "backup",
          backupDirectory: join(directory, "backups"),
        });
        assert.match(error.message, /backup folder/);
        return true;
      },
    );
    assert.equal(existsSync(join(directory, "missing")), false);
    assert.deepEqual(project.getAll().map((entry) => entry.key), ["APP"]);
  });
});

test("backup follows a working backups link", () => {
  withTestStore((directory) => {
    const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
    const target = join(directory, "backup-target");
    mkdirSync(target);
    project.create({ key: "APP" }, human);
    symlinkSync(target, join(directory, "backups"), "dir");

    const { path } = backup.create({ client: "test", version: "1.2.3" });

    assert.equal(dirname(path), realpathSync(target));
    assert.deepEqual(readdirSync(target), [basename(path)]);
  });
});

test("restore puts a backup's database back through the public operations, and its own backup undoes it", () => {
  withTestStore(() => {

    const { backupDirectory, directory } = getStorage();
    const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
    const build = { client: "test", version: "1.2.3" };
    const keys = (archive: "all" | "archived" | "active" = "all") => task.getAll({ archive }).map((entry) => entry.key);
    const found = (query: string) => task.search({ query, archive: "all" }).tasks.map((entry) => entry.key);

    const app = project.create({ key: "APP" }, human);
    const first = task.create({ project_id: app.id, title: "Widget login", description: "Sign in flow" }, human);
    task.create({ project_id: app.id, title: "Gadget export", description: null }, human);
    task.archive("APP-2", human);
    comment.create({ taskKey: "APP-1", text: "Needs a spinner" }, human);
    const saved = backup.create(build).path;
    const databaseAtBackup = { tasks: task.getAll({ archive: "all" }), comments: comment.getAll("APP-1") };

    task.create({ project_id: app.id, title: "Later work", description: null }, human);
    task.delete("APP-1", human);
    const databaseBeforeRestore = keys();

    // A file that is not a backup changes nothing.
    const notABackup = join(directory, "notes.txt");
    writeFileSync(notABackup, "not a backup");
    assert.throws(() => backup.restore({ ...build, path: notABackup }), RestoreRefusedError);
    assert.deepEqual(keys(), databaseBeforeRestore);

    const restored = backup.restore({ ...build, path: saved });
    assert.equal(restored.previousVersion, latestVersion(MIGRATIONS));
    assert.equal(restored.restoredVersion, latestVersion(MIGRATIONS));
    assert.deepEqual(task.getAll({ archive: "all" }), databaseAtBackup.tasks);
    assert.deepEqual(comment.getAll("APP-1"), databaseAtBackup.comments);
    assert.deepEqual(keys("archived"), ["APP-2"]);
    assert.deepEqual(found("spinner"), ["APP-1"]);
    assert.deepEqual(found("gadget"), ["APP-2"]);
    assert.deepEqual(found("later"), []);
    assert.equal(first.id, task.getByKey("APP-1").id);

    // The task counter came back with the database, so the next task gets the next number after the backup's.
    assert.equal(task.create({ project_id: app.id, title: "After restore", description: null }, human).key, "APP-3");

    backup.restore({ ...build, path: restored.backupPath! });
    assert.deepEqual(keys(), databaseBeforeRestore);
    assert.ok(readdirSync(backupDirectory).length === 3);

  });
});
test("restore onto a store with no database creates it, with no backup of a replaced database", () => {
  withTestStore((source) => {
    const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
    const build = { client: "test", version: "1.2.3" };
    const app = project.create({ key: "APP" }, human);
    task.create({ project_id: app.id, title: "Kept", description: null }, human);
    const backupPath = backup.create(build).path;
    withTestStore(() => {
      const { backupDirectory, databasePath } = getStorage();
      assert.equal(existsSync(databasePath), false);
      const result = backup.restore({ ...build, path: backupPath });
      assert.equal(result.backupPath, null);
      assert.equal(result.previousVersion, 0);
      assert.deepEqual(readdirSync(backupDirectory), []);
      assert.deepEqual(task.getAll().map((entry) => entry.title), ["Kept"]);
    });
  });
});
