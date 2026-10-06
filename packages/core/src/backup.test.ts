import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("same-time backups preserve earlier snapshots and include uncheckpointed WAL writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-backup-"));

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { setSystemTime } from "bun:test";
      import { Database } from "bun:sqlite";
      import { existsSync, readdirSync, readFileSync } from "node:fs";
      import { basename } from "node:path";
      import { backup } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      import { BACKUP_DIR, DB_PATH } from ${JSON.stringify(new URL("./constant.ts", import.meta.url).pathname)};

      setSystemTime(new Date("2026-10-03T12:30:05Z"));
      const db = getDb();
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("CREATE TABLE backup_test (value INTEGER)");
      db.exec("INSERT INTO backup_test VALUES (0)");
      const input = { client: "test", version: "1.2.3" };
      const first = backup.create(input).path;
      const firstBytes = readFileSync(first);
      const paths = new Set([first]);

      for (let value = 1; value <= 20; value++) {
        db.query("UPDATE backup_test SET value = ?").run(value);
        assert.ok(existsSync(DB_PATH + "-wal"));
        const { path } = backup.create(input);
        assert.ok(basename(path).startsWith("2026-10-03T12-30-05Z-test-1.2.3-"));
        assert.match(basename(path), /-[0-9a-f]{8}\\.sqlite$/);
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

      assert.deepEqual(readdirSync(BACKUP_DIR).sort(), [...paths].map((path) => basename(path)).sort());
      assert.deepEqual(readFileSync(first), firstBytes);
      const original = new Database(first, { readonly: true });
      try {
        assert.deepEqual(original.query("SELECT value FROM backup_test").get(), { value: 0 });
        assert.deepEqual(original.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
      } finally {
        original.close();
        db.close();
      }
    `], { env: { ...process.env, ZINN_DIR: directory } });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore puts a backup's board back through the public operations, and its own backup undoes it", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-restore-"));

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { existsSync, readdirSync } from "node:fs";
      import { backup, comment, project, RestoreRefusedError, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { BACKUP_DIR, CONFIG_PATH } from ${JSON.stringify(new URL("./constant.ts", import.meta.url).pathname)};

      const human = { name: "Test Human", email: "human@example.com", kind: "human" };
      const build = { client: "test", version: "1.2.3" };
      const keys = (archive = "all") => task.getAll({ archive }).map((entry) => entry.key);
      const found = (query) => task.search({ query, archive: "all" }).tasks.map((entry) => entry.key);

      const app = project.create({ key: "APP" }, human);
      const first = task.create({ project_id: app.id, title: "Widget login", description: "Sign in flow" }, human);
      task.create({ project_id: app.id, title: "Gadget export", description: null }, human);
      task.archive("APP-2", human);
      comment.create({ taskKey: "APP-1", text: "Needs a spinner" }, human);
      const saved = backup.create(build).path;
      const boardAtBackup = { tasks: task.getAll({ archive: "all" }), comments: comment.getAll("APP-1") };

      task.create({ project_id: app.id, title: "Later work", description: null }, human);
      task.delete("APP-1", human);
      const boardBeforeRestore = keys();

      // A file that is not a backup changes nothing.
      assert.throws(() => backup.restore({ ...build, path: CONFIG_PATH }), RestoreRefusedError);
      assert.deepEqual(keys(), boardBeforeRestore);

      const restored = backup.restore({ ...build, path: saved });
      assert.equal(restored.previousVersion, 1);
      assert.equal(restored.restoredVersion, 1);
      assert.deepEqual(task.getAll({ archive: "all" }), boardAtBackup.tasks);
      assert.deepEqual(comment.getAll("APP-1"), boardAtBackup.comments);
      assert.deepEqual(keys("archived"), ["APP-2"]);
      assert.deepEqual(found("spinner"), ["APP-1"]);
      assert.deepEqual(found("gadget"), ["APP-2"]);
      assert.deepEqual(found("later"), []);
      assert.equal(first.id, task.getByKey("APP-1").id);

      // The task counter came back with the board, so the next task gets the next number after the backup's.
      assert.equal(task.create({ project_id: app.id, title: "After restore", description: null }, human).key, "APP-3");

      backup.restore({ ...build, path: restored.backupPath });
      assert.deepEqual(keys(), boardBeforeRestore);
      assert.ok(readdirSync(BACKUP_DIR).length === 3);
    `], { env: { ...process.env, ZINN_DIR: directory } });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore onto a store with no database creates it, with its settings file and no backup of a replaced board", () => {
  const source = mkdtempSync(join(tmpdir(), "zinn-restore-source-"));
  const target = mkdtempSync(join(tmpdir(), "zinn-restore-target-"));
  const run = (directory: string, script: string) =>
    Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { existsSync, readdirSync } from "node:fs";
      import { backup, project, task } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { BACKUP_DIR, CONFIG_PATH, DB_PATH } from ${JSON.stringify(new URL("./constant.ts", import.meta.url).pathname)};
      const human = { name: "Test Human", email: "human@example.com", kind: "human" };
      const build = { client: "test", version: "1.2.3" };
      ${script}
    `], { env: { ...process.env, ZINN_DIR: directory } });

  try {
    const made = run(source, `
      const app = project.create({ key: "APP" }, human);
      task.create({ project_id: app.id, title: "Kept", description: null }, human);
      console.log(backup.create(build).path);
    `);
    expect(made.stderr.toString()).toBe("");
    const backupPath = made.stdout.toString().trim();

    const restored = run(target, `
      assert.equal(existsSync(DB_PATH), false);
      const result = backup.restore({ ...build, path: ${JSON.stringify(backupPath)} });
      assert.equal(result.backupPath, null);
      assert.equal(result.previousVersion, 0);
      assert.ok(existsSync(CONFIG_PATH));
      assert.deepEqual(readdirSync(BACKUP_DIR), []);
      assert.deepEqual(task.getAll().map((entry) => entry.title), ["Kept"]);
    `);
    expect(restored.stderr.toString()).toBe("");
    expect(restored.exitCode).toBe(0);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
