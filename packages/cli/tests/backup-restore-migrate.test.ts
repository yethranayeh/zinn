import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import packageJson from "../package.json";
import { runCliInTerminal } from "../testing";
import { backupFiles, CLI_PATH, createDatabase, databaseSnapshot, runProcessAsync, runZinn, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "../test-helpers";
import { errorDocumentSchema } from "../src/errors";
import { latestVersion, MIGRATIONS } from "../../core/src/migrations/registry";
import { createBaseline } from "../../core/src/migrations/baseline";
import { upgradeSchema } from "../../core/src/migrations/runner";
import { taskKeyIndexMigration } from "../../core/src/migrations/task-key-index";
import { seedBaseline } from "../../core/src/migrations/testing";
import { openDatabase } from "../../core/src/sqlite/bun";

// ? End-to-end tests: each case spawns the real bin, so `ZINN_DIR` is passed
// ? per-spawn rather than set on `process.env`.

const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);
const BEFORE_TASK_KEY_INDEX = taskKeyIndexMigration.version - 1;

/** The task-key migration rejects this schema when the optional duplicate is present. */
function createBeforeTaskKeyIndex(store: string, duplicate = false) {
  const databasePath = join(store, "data", "zinn.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);
  try {
    seedBaseline(db);
    upgradeSchema(db, MIGRATIONS.filter(({ version }) => version < taskKeyIndexMigration.version));
    if (duplicate) {
      db.exec(`INSERT INTO task (id, project_id, column_id, number, title, created_at, updated_at)
        VALUES ('duplicate', 'p1', 'c1', 2, 'Duplicate', 11, 11)`);
    }
  } finally {
    db.close();
  }
  return databasePath;
}

function runZinnWithPreload(args: Array<string>, store: string, source: string) {
  const preload = join(store, "fault.ts");
  writeFileSync(preload, source);
  return runProcessAsync([process.execPath, "--preload", preload, CLI_PATH, ...args], {
    cwd: store,
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: store },
  });
}

function runWithBackupFailure(
  args: Array<string>,
  store: string,
  failure: "rename" | "directory-sync" | "verification" | "verification-and-rename",
) {
  const backupDirectory = join(realpathSync(store), "backups");
  return runZinnWithPreload(args, store, `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const original = { ...fs };
    const backupDirectory = ${JSON.stringify(backupDirectory)};
    const failure = ${JSON.stringify(failure)};
    let renamed = false;
    let directoryDescriptor;
    let snapshot;
    mock.module("node:fs", () => ({
      ...original,
      renameSync(from, to) {
        const publishesBackup = String(from).endsWith(".sqlite.partial");
        if (publishesBackup && (failure === "rename" || failure === "verification-and-rename")) {
          throw Object.assign(new Error("injected backup rename failure"), { code: "EIO", syscall: "rename" });
        }
        original.renameSync(from, to);
        renamed ||= publishesBackup;
      },
      openSync(path, ...args) {
        const descriptor = original.openSync(path, ...args);
        if (renamed && path === backupDirectory) {
          directoryDescriptor = descriptor;
        }
        if (String(path).endsWith(".sqlite.partial") && failure.startsWith("verification")) {
          snapshot = { descriptor, path };
        }
        return descriptor;
      },
      fsyncSync(descriptor) {
        if (snapshot?.descriptor === descriptor) {
          original.writeFileSync(snapshot.path, "damaged snapshot");
          snapshot = undefined;
        }
        if (failure === "directory-sync" && descriptor === directoryDescriptor) {
          directoryDescriptor = undefined;
          throw Object.assign(new Error("injected directory fsync failure"), { code: "EINVAL", syscall: "fsync" });
        }
        original.fsyncSync(descriptor);
      },
    }));
  `);
}

function runWithMigrationFailure(
  args: Array<string>,
  store: string,
  failure: "commit" | "foreign-keys" | "close" | "close-after-no-op" | "detach",
) {
  const core = new URL("../../core/index.ts", import.meta.url).href;
  const sqlite = new URL("../../core/src/sqlite/database.ts", import.meta.url).href;
  const databasePath = join(realpathSync(store), "data", "zinn.sqlite");
  return runZinnWithPreload(args, store, `
    import { migrate } from ${JSON.stringify(core)};
    import { Database } from ${JSON.stringify(sqlite)};
    const failure = ${JSON.stringify(failure)};
    const databasePath = ${JSON.stringify(databasePath)};
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    let committedConnection;
    let waitingConnection;
    let injected = false;

    function fail(syscall) {
      injected = true;
      throw Object.assign(new Error("injected " + failure + " failure"), { code: "EIO", syscall });
    }

    Database.prototype.exec = function (sql) {
      const isDestination = this.databasePath === databasePath;
      if (isDestination && failure === "close-after-no-op" && sql === "BEGIN IMMEDIATE" && !waitingConnection) {
        waitingConnection = this;
        migrate.run({ client: "test", version: "1" });
      }
      if (!injected && isDestination && failure === "commit" && sql === "COMMIT") {
        fail("write");
      }
      if (!injected && this === committedConnection) {
        if (failure === "foreign-keys" && /^PRAGMA foreign_keys = [01]$/.test(sql)) {
          fail("write");
        }
        if (failure === "detach" && sql.startsWith("DETACH DATABASE ")) {
          fail("close");
        }
      }
      exec.call(this, sql);
      if (isDestination && sql === "COMMIT") {
        committedConnection = this;
      }
    };
    Database.prototype.close = function () {
      const failsOnClose = failure === "close" || (failure === "close-after-no-op" && this === waitingConnection);
      if (!injected && failsOnClose && this === committedConnection) {
        fail("close");
      }
      close.call(this);
    };
    process.on("exit", () => {
      if (!injected) {
        throw new Error("Expected to inject a database failure");
      }
    });
  `);
}

function createRestoreSource(store: string) {
  const source = createBeforeTaskKeyIndex(store);
  withTestDb(store, (db) => db.exec("UPDATE task SET title = 'Restored title' WHERE id = 't1'"));
  return source;
}

test.each([
  ["migrate", "close"],
  ["migrate", "foreign-keys"],
  ["restore", "close"],
  ["restore", "foreign-keys"],
] as const)("%s reports its applied result when %s fails after commit", async (operation, failure) => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    const databasePath = createBeforeTaskKeyIndex(store);
    const args = operation === "migrate"
      ? ["migrate"]
      : ["restore", createRestoreSource(join(root, "source")), "--yes"];
    const schemaVersion = operation === "migrate" ? CURRENT_SCHEMA_VERSION : BEFORE_TASK_KEY_INDEX;

    const result = await runWithMigrationFailure([...args, "--json"], store, failure);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const snapshots = backupFiles(store);
    expect(snapshots).toEqual([expect.stringMatching(/\.sqlite$/)]);
    const backupPath = join(realpathSync(store), "backups", snapshots[0]!);
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    expect(error).toMatchObject({
      code: "storage",
      details: { applied: true, backupPath, databasePath: realpathSync(databasePath), schemaVersion, cause: { code: "EIO" } },
    });
    expect(error.details?.cause?.message).toContain(failure);
    expect(error.message).toContain(backupPath);
    expect(error.diagnostics?.join("\n") ?? "").not.toContain("unchanged");
    expect(databaseSnapshot(store)).toMatchObject({
      version: { user_version: schemaVersion },
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: "t1", title: operation === "restore" ? "Restored title" : "First" }),
      ]),
    });
  });
});

test.each(["migrate", "restore"] as const)("%s reports an unchanged database when COMMIT fails", async (operation) => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    createBeforeTaskKeyIndex(store);
    const before = databaseSnapshot(store);
    const args = operation === "migrate"
      ? ["migrate"]
      : ["restore", createRestoreSource(join(root, "source")), "--yes"];

    const result = await runWithMigrationFailure([...args, "--json"], store, "commit");
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    expect(error.details?.applied).toBeUndefined();
    expect(error.details?.cause?.code).toBe("EIO");
    expect(error.diagnostics?.join("\n")).toContain("unchanged");
    expect(databaseSnapshot(store)).toEqual(before);
    expect(backupFiles(store)).toEqual([expect.stringMatching(/\.sqlite$/)]);
  });
});

test("a restore onto a missing database reports the applied restore without a prior snapshot", async () => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    mkdirSync(store);
    const source = createRestoreSource(join(root, "source"));

    const result = await runWithMigrationFailure(["restore", source, "--yes", "--json"], store, "close");
    expect(result.code, result.stderr).toBe(1);
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    expect(error.details?.applied).toBe(true);
    expect(error.details?.backupPath).toBeUndefined();
    expect(backupFiles(store)).toEqual([]);
    expect(databaseSnapshot(store).tasks).toContainEqual(expect.objectContaining({ id: "t1", title: "Restored title" }));
  });
});

test("migrate reports the committed upgrade and retained backup in text mode", async () => {
  await withIsolatedZinnDir(async (store) => {
    createBeforeTaskKeyIndex(store);

    const result = await runWithMigrationFailure(["migrate"], store, "close");
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const snapshots = backupFiles(store);
    expect(snapshots).toHaveLength(1);
    expect(result.stderr).toContain(join(realpathSync(store), "backups", snapshots[0]!));
    expect(result.stderr).toContain(`schema version ${CURRENT_SCHEMA_VERSION}`);
    expect(result.stderr).not.toContain("unchanged");
  });
});

test("migrate reports no applied upgrade when another connection upgraded before it acquired the lock", async () => {
  await withIsolatedZinnDir(async (store) => {
    createBeforeTaskKeyIndex(store);

    const result = await runWithMigrationFailure(["migrate", "--json"], store, "close-after-no-op");
    expect(result.code, result.stderr).toBe(1);
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    expect(error.details?.applied).toBeUndefined();
    expect(error.details?.backupPath).toBeUndefined();
    expect(error.details?.cause?.code).toBe("EIO");
    expect(databaseSnapshot(store).version).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(backupFiles(store)).toHaveLength(1);
  });
});

test("restore returns the committed result when closing takes care of a failed detach", async () => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    createBeforeTaskKeyIndex(store);
    const source = createRestoreSource(join(root, "source"));

    const result = await runWithMigrationFailure(["restore", source, "--yes", "--json"], store, "detach");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ restoredVersion: BEFORE_TASK_KEY_INDEX });
    expect(databaseSnapshot(store).tasks).toContainEqual(expect.objectContaining({ id: "t1", title: "Restored title" }));
  });
});

test("a committed automatic upgrade reports an applied change when resetting foreign keys fails", async () => {
  await withIsolatedZinnDir(async (store) => {
    const databasePath = createBeforeTaskKeyIndex(store);
    const title = "Created after reopening";
    const args = ["task", "create", "APP", "--title", title, "--json"];

    const result = await runWithMigrationFailure(args, store, "foreign-keys");
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    const snapshots = backupFiles(store);
    expect(snapshots).toHaveLength(1);
    expect(error).toMatchObject({
      code: "storage",
      details: { applied: true, databasePath: realpathSync(databasePath), schemaVersion: CURRENT_SCHEMA_VERSION, cause: { code: "EIO" } },
    });
    expect(error.details?.backupPath).toBe(join(realpathSync(store), "backups", snapshots[0]!));
    expect(error.message).not.toContain("zinn migrate");
    const afterUpgrade = databaseSnapshot(store);
    expect(afterUpgrade.version).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(afterUpgrade.tasks).not.toContainEqual(expect.objectContaining({ title }));

    const next = await runZinn(args, store);
    expect(next.code, next.stderr).toBe(0);
    expect(databaseSnapshot(store).tasks).toContainEqual(expect.objectContaining({ title }));
    expect(backupFiles(store)).toEqual(snapshots);
  });
});

test.skipIf(process.platform === "win32")("backup reports the final snapshot path and directory failure on stderr", async () => {
  await withIsolatedZinnDir(async (store) => {
    createBeforeTaskKeyIndex(store);

    const result = await runWithBackupFailure(["backup"], store, "directory-sync");
    const files = backupFiles(store);
    expect(files).toEqual([expect.stringMatching(/\.sqlite$/)]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const backupPath = join(realpathSync(store), "backups", files[0]!);
    expect(result.stderr).toContain(backupPath);
    expect(result.stderr).toContain("injected directory fsync failure");

    const snapshot = new Database(backupPath, { readonly: true });
    try {
      expect(snapshot.query("SELECT title FROM task WHERE id = 't1'").get()).toEqual({ title: "First" });
    } finally {
      snapshot.close();
    }
  });
});

test.skipIf(process.platform === "win32")("a directory sync failure after an automatic backup reports why retries are paused", async () => {
  await withIsolatedZinnDir(async (store) => {
    createBeforeTaskKeyIndex(store);
    const before = databaseSnapshot(store);
    const args = ["project", "list", "--json"];

    const first = await runWithBackupFailure(args, store, "directory-sync");
    const files = backupFiles(store);
    expect(files).toEqual([expect.stringMatching(/\.sqlite$/)]);
    expect(first.code).toBe(1);
    expect(first.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(first.stderr));
    expect(error).toMatchObject({
      code: "storage",
      details: {
        entity: "backup",
        backupPath: join(realpathSync(store), "backups", files[0]!),
        cause: { code: "EINVAL" },
      },
    });
    expect(error.details?.cause?.message).toContain("injected directory fsync failure");
    expect(error.message).toContain("zinn migrate");

    const retry = await runZinn(args, store);
    expect(retry.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(retry.stderr)).error.details?.reason).toBe("migration_paused");
    expect(backupFiles(store)).toEqual(files);
    expect(databaseSnapshot(store)).toEqual(before);
  });
});

test("automatic upgrade retries after a failed backup rename", async () => {
  await withIsolatedZinnDir(async (store) => {
    createBeforeTaskKeyIndex(store);
    const args = ["project", "list", "--json"];

    const first = await runWithBackupFailure(args, store, "rename");
    expect(first.code).toBe(1);
    const { error } = errorDocumentSchema.parse(JSON.parse(first.stderr));
    expect(error.details?.cause?.code).toBe("EIO");
    expect(error.details?.backupPath).toBeUndefined();
    expect(error.message).not.toContain("zinn migrate");
    expect(backupFiles(store)).toEqual([]);

    const retry = await runZinn(args, store);
    expect(retry.code).toBe(0);
    expect(backupFiles(store)).toEqual([expect.stringMatching(/\.sqlite$/)]);
    expect(databaseSnapshot(store).version).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  });
});

test("ZINN-508: ordinary opens pause after a failed automatic upgrade and explicit migrate retries", async () => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    const databasePath = createBeforeTaskKeyIndex(store, true);
    const before = databaseSnapshot(store);
    const alias = join(root, "alias");
    symlinkSync(store, alias, "dir");

    const first = await runZinn(["project", "list", "--json"], store);
    expect(first.code).toBe(1);
    const firstError = errorDocumentSchema.parse(JSON.parse(first.stderr)).error;
    expect(firstError.message).toContain("APP-2");
    expect(firstError.message).toContain("zinn migrate");
    expect(backupFiles(store)).toHaveLength(1);

    for (const location of [store, alias]) {
      const paused = await runZinn(["project", "list", "--json"], location);
      expect(paused.code).toBe(1);
      expect(paused.stdout).toBe("");
      const { error } = errorDocumentSchema.parse(JSON.parse(paused.stderr));
      expect(error).toMatchObject({
        code: "conflict",
        details: {
          entity: "database",
          reason: "migration_paused",
          databasePath,
          schemaVersion: taskKeyIndexMigration.version - 1,
          supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
        },
      });
      expect(error.message).toContain("zinn migrate");
    }
    expect(backupFiles(store)).toHaveLength(1);
    expect(databaseSnapshot(store)).toEqual(before);
    expect((await runZinn(["info", "--json"], store)).code).toBe(0);
    expect((await runZinn(["backup", "--json"], store)).code).toBe(0);

    const failedRetry = await runZinn(["migrate", "--json"], store);
    expect(failedRetry.code).toBe(1);
    expect(failedRetry.stderr).toContain("APP-2");
    expect((await runZinn(["project", "list"], store)).stderr).toContain("zinn migrate");
    expect(backupFiles(store)).toHaveLength(3);

    const db = openDatabase(databasePath);
    try {
      db.exec("UPDATE task SET number = 4 WHERE id = 'duplicate'");
    } finally {
      db.close();
    }
    const retry = await runZinn(["migrate", "--json"], store);
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ changed: true, finalVersion: CURRENT_SCHEMA_VERSION });
    expect((await runZinn(["project", "list", "--json"], store)).code).toBe(0);
    expect(backupFiles(store)).toHaveLength(4);
    expect(existsSync(`${databasePath}.migration.json`)).toBe(false);
  });
});

test.each(["restore", "replace", "copy"] as const)("ZINN-508: a database %s resets the pause at the same schema", async (operation) => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    const databasePath = createBeforeTaskKeyIndex(store, true);
    const replacement = createBeforeTaskKeyIndex(join(root, "replacement"));
    const first = await runZinn(["project", "list"], store);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("APP-2");

    if (operation === "restore") {
      const backup = openDatabase(replacement);
      try {
        backup.exec("PRAGMA foreign_keys = OFF");
        backup.exec("UPDATE comment SET task_id = 'missing' WHERE id = 'm1'");
        const before = databaseSnapshot(store);
        const snapshotCount = backupFiles(store).length;
        const failed = await runZinn(["restore", replacement, "--yes"], store);
        expect(failed.code).toBe(1);
        expect(backupFiles(store)).toHaveLength(snapshotCount + 1);
        expect(databaseSnapshot(store)).toEqual(before);
        expect((await runZinn(["project", "list"], store)).stderr).toContain("zinn migrate");
        backup.exec("UPDATE comment SET task_id = 't1' WHERE id = 'm1'");
      } finally {
        backup.close();
      }
      const restored = await runZinn(["restore", replacement, "--yes", "--json"], store);
      expect(restored.code).toBe(0);
      expect(JSON.parse(restored.stdout)).toMatchObject({
        previousVersion: taskKeyIndexMigration.version - 1,
        restoredVersion: taskKeyIndexMigration.version - 1,
      });
      expect(existsSync(`${databasePath}.migration.json`)).toBe(false);
    } else if (operation === "replace") {
      renameSync(replacement, databasePath);
    } else {
      // A copy of a Zinn backup over the file keeps its inode
      const copied = join(root, "copied.sqlite");
      const source = new Database(replacement);
      try {
        source.exec(`VACUUM INTO '${copied}'`);
      } finally {
        source.close();
      }
      const inode = statSync(databasePath).ino;
      for (const sidecar of ["-wal", "-shm"]) {
        rmSync(`${databasePath}${sidecar}`, { force: true });
      }
      copyFileSync(copied, databasePath);
      expect(statSync(databasePath).ino).toBe(inode);
    }

    const kept = backupFiles(store);
    expect((await runZinn(["project", "list", "--json"], store)).code).toBe(0);
    expect(backupFiles(store)).toHaveLength(kept.length + 1);
    expect(backupFiles(store)).toEqual(expect.arrayContaining(kept));
  });
});

test("backup saves a copy of the database named with the UTC time and CLI version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "BAK"], dir);
    await runZinn(["task", "create", "BAK", "--title", "Saved"], dir);

    const result = await runZinn(["backup", "--json"], dir);
    expect(result.code).toBe(0);

    const { path } = JSON.parse(result.stdout) as { path: string };
    expect(dirname(path)).toBe(join(dir, "backups"));
    expect(basename(path)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/);
    expect(basename(path)).toContain(`Z-cli-${packageJson.version}-`);
    expect(basename(path)).toMatch(/-[0-9a-f]{8}\.sqlite$/);

    const backupDb = new Database(path, { readonly: true });
    try {
      expect(backupDb.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
      expect(backupDb.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      backupDb.close();
    }
  });
});

for (const failure of ["verification", "verification-and-rename"] as const) {
  test(`backup reports and retains a damaged copy after ${failure}`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      await runZinn(["project", "create", "BAK"], dir);
      const result = await runWithBackupFailure(["backup", "--json"], dir, failure);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
      const path = error.details?.backupPath;
      expect(error).toMatchObject({
        code: "storage",
        details: { entity: "backup", cause: { code: "SQLITE_NOTADB" } },
      });
      expect(path).toEndWith(failure === "verification" ? ".sqlite.failed" : ".sqlite.partial");
      expect(error.message).toContain(path!);
      expect(backupFiles(dir)).toEqual([basename(path!)]);
      expect(readFileSync(path!, "utf8")).toBe("damaged snapshot");
    });
  });
}

test("backup fails and retains a copy whose foreign keys point to missing rows", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "BAK"], dir);
    withTestDb(dir, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("UPDATE project_column SET project_id = 'missing-project' WHERE rowid = (SELECT min(rowid) FROM project_column)");
    });

    const result = await runZinn(["backup", "--json"], dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = errorDocumentSchema.parse(JSON.parse(result.stderr));
    const path = error.details?.backupPath;
    expect(error).toMatchObject({ code: "storage", details: { entity: "backup" } });
    expect(path).toEndWith(".sqlite.failed");
    expect(error.message).toContain(path!);
    expect(backupFiles(dir)).toEqual([basename(path!)]);
    const copy = new Database(path!, { readonly: true });
    try {
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(copy.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    } finally {
      copy.close();
    }
  });
});

test("backup refuses when there is no database and does not create one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a zero-byte database file without creating backups", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");

    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("backup refuses a database header with no tables without creating backups", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    const db = new Database(databasePath);
    db.exec("PRAGMA user_version = 0");
    db.close();
    const before = readFileSync(databasePath);
    expect(before.length).toBeGreaterThan(0);

    const result = await runZinn(["--json", "backup"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("a dangling backups link leaves reads and writes working, and fails only backup and migrate naming the folder", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "LNK"], dir);
    await runZinn(["task", "create", "LNK", "--title", "Kept"], dir);
    const backupDirectory = join(dir, "backups");
    symlinkSync(join(dir, "missing"), backupDirectory, "dir");

    expect((await runZinn(["task", "list", "--json"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "LNK", "--title", "Also kept"], dir)).code).toBe(0);

    for (const args of [["backup", "--json"], ["migrate", "--json"]]) {
      const result = await runZinn(args, dir);
      expect(result.code, args.join(" ")).toBe(1);
      const error = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(error.code).toBe("storage");
      expect(error.message).toContain(backupDirectory);
      expect(error.message).not.toContain("Cannot resolve the database path");
      expect(error.details).toMatchObject({ entity: "backup", backupDirectory });
      expect(error.details?.databasePath).toBeUndefined();
      expect(error.diagnostics?.some((entry) => entry.includes("Backups taken")) ?? false).toBe(false);
    }
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});

test("backup follows a working backups link and reports the resolved path", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const target = join(dir, "backup-target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "backups"), "dir");
    await runZinn(["project", "create", "LNK"], dir);

    const result = await runZinn(["backup", "--json"], dir);

    expect(result.code).toBe(0);
    const { path } = JSON.parse(result.stdout) as { path: string };
    expect(dirname(path)).toBe(realpathSync(target));
    expect(readdirSync(target)).toEqual([basename(path)]);
  });
});

// ? A backup of a fresh store holding one task, made by the CLI, in its own directory.
async function backupWithTask(dir: string, title: string) {
  await runZinn(["project", "create", "RST"], dir);
  await runZinn(["task", "create", "RST", "--title", title], dir);
  return (JSON.parse((await runZinn(["backup", "--json"], dir)).stdout) as { path: string }).path;
}

function taskTitles(dir: string) {
  return withTestDb(dir, (db) => db.query("SELECT title FROM task ORDER BY number").all());
}

test("restore explains recovery from damaged task and comment pages without changing the database", async () => {
  for (const table of ["task", "comment"]) {
    await withIsolatedZinnDir(async (dir) => {
      const path = await backupWithTask(dir, "Kept");
      const databasePath = join(dir, "data", "zinn.sqlite");
      const { pageSize, rootPage } = withTestDb(dir, (db) => {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        return {
          pageSize: (db.query("PRAGMA page_size").get() as { page_size: number }).page_size,
          rootPage: (db.query("SELECT rootpage FROM sqlite_schema WHERE name = ?").get(table) as { rootpage: number }).rootpage,
        };
      });
      const damaged = readFileSync(databasePath);
      const pageOffset = (rootPage - 1) * pageSize;
      damaged.fill(0, pageOffset, pageOffset + pageSize);
      writeFileSync(databasePath, damaged);
      const previousBackups = backupFiles(dir);

      const result = await runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(databasePath);
      const json = await runZinn(["restore", path, "--yes", "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      const corrupt = errorDocumentSchema.parse(JSON.parse(json.stderr)).error;
      expect(corrupt).toMatchObject({ code: "storage", details: { reason: "corrupt" } });
      expect(existsSync(corrupt.details!.logPath!)).toBe(true);
      expect(result.stderr).toContain(`${databasePath}-wal`);
      expect(result.stderr).toContain(`${databasePath}-shm`);
      expect(result.stderr).toContain("zinn restore");
      expect(result.stderr).not.toContain("[y/N]");
      expect(readFileSync(databasePath)).toEqual(damaged);
      expect(backupFiles(dir)).toEqual(previousBackups);

      const saved = join(dir, "damaged");
      mkdirSync(saved);
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${databasePath}${suffix}`;
        if (existsSync(file)) {
          renameSync(file, join(saved, `zinn.sqlite${suffix}`));
        }
      }

      const recovered = await runZinn(["restore", path, "--yes"], dir);
      expect(recovered.code).toBe(0);
      expect(recovered.stderr).toBe("");
      expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
      expect(readFileSync(join(saved, "zinn.sqlite"))).toEqual(damaged);
    });
  }
});

test("restore replaces the database after confirmation and saves the replaced database as a backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);

    const result = await runZinn(["restore", path, "--yes"], dir);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(`schema version ${CURRENT_SCHEMA_VERSION}`);
    expect(result.stdout).toContain(`${join(dir, "backups")}/`);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);

    const saved = backupFiles(dir).map((name) => join(dir, "backups", name)).filter((file) => file !== path);
    expect(saved).toHaveLength(1);
    const savedDb = new Database(saved[0]!, { readonly: true });
    try {
      expect(savedDb.query("SELECT title FROM task ORDER BY number").all()).toEqual([{ title: "Kept" }, { title: "Later" }]);
    } finally {
      savedDb.close();
    }
  });
});

test.serial("restore keeps the database when confirmation is declined", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const result = await runCliInTerminal(["restore", path], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "n\n" });

    expect(result.code).toBe(0);
    expect(result.output).toContain(join(dir, "data", "zinn.sqlite"));
    expect(result.output).toContain(path);
    expect(result.output).toContain("[y/N]");
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);
  });
});

/** Two stores, each holding one task, and a link selecting the first of them. */
async function linkedStores(root: string) {
  const first = join(root, "first");
  const second = join(root, "second");
  for (const [store, title] of [[first, "First"], [second, "Second"]] as const) {
    mkdirSync(store);
    await runZinn(["project", "create", "RST"], store);
    await runZinn(["task", "create", "RST", "--title", title], store);
  }
  const link = join(root, "selected");
  symlinkSync(first, link, "dir");
  return { first, second, link };
}

function retarget(link: string, target: string) {
  unlinkSync(link);
  symlinkSync(target, link, "dir");
}

for (const { answer, restores } of [{ answer: "y", restores: true }, { answer: "n", restores: false }]) {
  test.serial(`restore answered ${answer} acts only on the database it showed, after the store link changes at the prompt (ZINN-513)`, async () => {
    await withIsolatedZinnDir(async (root) => {
      const source = join(root, "source");
      mkdirSync(source);
      const path = await backupWithTask(source, "Kept");
      const { first, second, link } = await linkedStores(root);

      const result = await runCliInTerminal(["restore", path], {
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: link },
        cwd: root,
        inputWhen: "[y/N]",
        beforeInput: () => retarget(link, second),
        input: `${answer}\n`,
      });

      expect(result.code).toBe(0);
      expect(result.output).toContain(join(realpathSync(first), "data", "zinn.sqlite"));
      expect(result.output).not.toContain(second);
      expect(taskTitles(first)).toEqual(restores ? [{ title: "Kept" }] : [{ title: "First" }]);
      expect(backupFiles(first)).toHaveLength(restores ? 1 : 0);
      expect(taskTitles(second)).toEqual([{ title: "Second" }]);
      expect(backupFiles(second)).toEqual([]);
    });
  });
}

test.serial("restore checks the backup again after confirmation and refuses one that changed at the prompt (ZINN-513)", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const result = await runCliInTerminal(["restore", path], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir },
      cwd: dir,
      inputWhen: "[y/N]",
      beforeInput: () => writeFileSync(path, "not a database"),
      input: "y\n",
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain(path);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);
  });
});

test("restore with --json needs --yes, and with it prints the restore result", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const path = await backupWithTask(dir, "Kept");
    await runZinn(["task", "create", "RST", "--title", "Later"], dir);
    const backupsBefore = backupFiles(dir);

    const refused = await runZinn(["restore", path, "--json"], dir);
    expect(refused.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(refused.stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--yes", reason: "confirmation_required" },
    });
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }, { title: "Later" }]);
    expect(backupFiles(dir)).toEqual(backupsBefore);

    const result = await runZinn(["restore", path, "--yes", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const restored = JSON.parse(result.stdout);
    expect(restored).toEqual({
      databasePath: realpathSync(join(dir, "data", "zinn.sqlite")),
      previousVersion: CURRENT_SCHEMA_VERSION,
      restoredVersion: CURRENT_SCHEMA_VERSION,
      backupPath: expect.any(String),
    });
    expect(dirname(restored.backupPath)).toBe(join(dir, "backups"));
    expect(existsSync(restored.backupPath)).toBe(true);
    expect(taskTitles(dir)).toEqual([{ title: "Kept" }]);
  });
});

test("restore refuses a file that is not a backup it can restore, printing why and changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (newerDir) => {
      await createDatabase(dir, 1);
      const before = databaseSnapshot(dir);
      const textFile = join(newerDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");
      const newer = await backupWithTask(newerDir, "From the future");
      withTestDb(newerDir, (db) => db.run("PRAGMA user_version = 9"));
      const newerBackup = (JSON.parse((await runZinn(["backup", "--json"], newerDir)).stdout) as { path: string }).path;

      const notDatabase = await runZinn(["restore", textFile, "--yes"], dir);
      expect(notDatabase.code).toBe(1);
      expect(notDatabase.stdout).toBe("");
      expect(notDatabase.stderr).toContain(textFile);

      // ? Without --yes, the refusal comes before the prompt.
      const newerResult = await runZinn(["restore", newerBackup], dir);
      expect(newerResult.code).toBe(1);
      expect(newerResult.stdout).toBe("");
      expect(newerResult.stderr).toContain(newerBackup);
      expect(newerResult.stderr).toContain("9");
      expect(newerResult.stderr).toContain("cli");
      expect(newerResult.stderr).toContain(packageJson.version);
      expect(newerResult.stderr).not.toContain("[y/N]");

      const missing = await runZinn(["restore", join(newerDir, "missing.sqlite"), "--yes", "--json"], dir);
      expect(missing.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(missing.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "backup", backupPath: join(newerDir, "missing.sqlite") } });

      expect(databaseSnapshot(dir)).toEqual(before);
      expect(existsSync(join(dir, "backups"))).toBe(false);
      expect(newer).not.toBe(newerBackup);
    });
  });
});

test("a refused restore onto a store with no database creates only its failure log and telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (otherDir) => {
      const textFile = join(otherDir, "notes.sqlite");
      writeFileSync(textFile, "not a database");

      expect((await runZinn(["restore", textFile, "--yes"], dir)).code).toBe(1);
      expect((await runZinn(["restore", textFile], dir)).code).toBe(1);
      expect(withoutTelemetry(readdirSync(dir))).toEqual(["logs"]);
    });
  });
});

test("restore onto a store with no database creates it from the backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await withIsolatedZinnDir(async (sourceDir) => {
      const path = await backupWithTask(sourceDir, "Kept");

      const result = await runZinn(["restore", path, "--yes"], dir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(path);
      expect(result.stdout).toContain(`schema version ${CURRENT_SCHEMA_VERSION}`);
      expect(backupFiles(dir)).toEqual([]);
      expect((await runZinn(["task", "list", "RST"], dir)).stdout).toContain("Kept");
    });
  });
});

test("restore works on newer and unmarked databases", async () => {
  await withIsolatedZinnDir(async (sourceDir) => {
    const path = await backupWithTask(sourceDir, "Kept");

    for (const version of [9, 0]) {
      await withIsolatedZinnDir(async (dir) => {
        await createDatabase(dir, version);

        const result = await runZinn(["restore", path, "--yes", "--json"], dir);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ previousVersion: version, restoredVersion: CURRENT_SCHEMA_VERSION });
        expect((await runZinn(["task", "list", "RST"], dir)).stdout).toContain("Kept");
        expect(backupFiles(dir)).toHaveLength(1);
      });
    }
  });
});

test("restore needs exactly one backup path", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["restore", "--yes"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: zinn restore");
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

function storeSnapshot(dir: string) {
  return withoutTelemetry(readdirSync(dir, { recursive: true, encoding: "utf8" })).sort().map((entry) => {
    const path = join(dir, entry);
    return { entry, size: statSync(path).isFile() ? statSync(path).size : null };
  });
}

test("ZINN-458: reads and writes that need records report a missing or empty database and leave the store as it was apart from telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const emptyFolder = join(dir, "empty-folder");
    mkdirSync(emptyFolder);
    const zeroByteFile = join(dir, "zero-byte");
    mkdirSync(join(zeroByteFile, "data"), { recursive: true });
    writeFileSync(join(zeroByteFile, "data", "zinn.sqlite"), "");
    const commands = [
      ["task", "view", "APP-1"],
      ["task", "list"],
      ["project", "list"],
      ["task", "comment", "create", "APP-1", "--text", "Note"],
      ["label", "edit", "bug", "--color", "red"],
    ];

    for (const store of [emptyFolder, zeroByteFile]) {
      const before = storeSnapshot(store);
      for (const args of commands) {
        const json = await runZinn(["--json", ...args], store);
        expect(json.code, args.join(" ")).toBe(1);
        expect(json.stdout).toBe("");
        expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error).toMatchObject({
          code: "not_found",
          details: { entity: "database", databasePath: join(store, "data", "zinn.sqlite") },
        });

        const text = await runZinn(args, store);
        expect(text.code).toBe(1);
        expect(text.stderr).toContain("zinn project create");
      }
      expect(storeSnapshot(store)).toEqual(before);

      expect((await runZinn(["project", "create", "APP"], store)).code).toBe(0);
      expect((await runZinn(["task", "list", "--json"], store)).code).toBe(0);
    }
  });
});

test("ZINN-458: label create creates the database, like project create", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["label", "create", "bug"], dir)).code).toBe(0);
    expect(JSON.parse((await runZinn(["project", "list", "--json"], dir)).stdout)).toEqual([]);
    expect(JSON.parse((await runZinn(["label", "list", "--json"], dir)).stdout)).toMatchObject([{ name: "bug" }]);
  });
});

test("ZINN-458: refusals of a missing database name the command that creates one", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const args of [["backup"], ["migrate"], ["reindex"]]) {
      const result = await runZinn(args, dir);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("zinn project create");
    }
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

test("migrate refuses when there is no database and creates only telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
    expect(result.stderr).not.toContain("[y/N]");
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

test("migrate refuses an empty database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    mkdirSync(join(dir, "data"));
    new Database(join(dir, "data", "zinn.sqlite")).close();
    const before = readFileSync(join(dir, "data", "zinn.sqlite"));
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
    expect(readFileSync(join(dir, "data", "zinn.sqlite"))).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses an unmarked database and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["migrate", "--json"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0 } });

    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate refuses a newer database and reports both versions and the CLI version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "migrate"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    expect(result.stderr).not.toContain("[y/N]");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate on a current database is a no-op with no backup", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, CURRENT_SCHEMA_VERSION);
    const before = databaseSnapshot(dir);

    const result = await runZinn(["migrate", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(dir, "data", "zinn.sqlite"),
      previousVersion: CURRENT_SCHEMA_VERSION,
      finalVersion: CURRENT_SCHEMA_VERSION,
      changed: false,
      backupPath: null,
    });
    expect((await runZinn(["migrate"], dir)).stdout).toContain(String(CURRENT_SCHEMA_VERSION));
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("migrate reports the same resolved database path when it upgrades and when it then finds the database current (ZINN-513)", async () => {
  await withIsolatedZinnDir(async (root) => {
    const store = join(root, "store");
    mkdirSync(join(store, "data"), { recursive: true });
    const db = openDatabase(join(store, "data", "zinn.sqlite"));
    try {
      createBaseline(db);
      db.exec("PRAGMA user_version = 1");
    } finally {
      db.close();
    }
    const link = join(root, "selected");
    symlinkSync(store, link, "dir");

    const upgraded = await runZinn(["migrate", "--json"], link);
    const unchanged = await runZinn(["migrate", "--json"], link);

    expect(upgraded.code).toBe(0);
    expect(unchanged.code).toBe(0);
    const upgradedResult = JSON.parse(upgraded.stdout);
    const unchangedResult = JSON.parse(unchanged.stdout);
    expect(upgradedResult).toMatchObject({ databasePath: join(realpathSync(store), "data", "zinn.sqlite"), changed: true });
    expect(unchangedResult).toMatchObject({ databasePath: upgradedResult.databasePath, changed: false, backupPath: null });
  });
});
