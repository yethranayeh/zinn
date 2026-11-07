import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { backup, configureDatabase, info, project, reindex } from "../index";
import type { DatabaseFacts } from "../index";
import { resolveDatabasePath } from "./database-path";
import { assertWritable, getDb } from "./db";
import { CoreError } from "./errors";
import { getBackupStorage, getStorage } from "./storage";
import { withEnvironment, withStore, withTestStore } from "./testing";
import { driver } from "./sqlite/bun";
import { openDatabase } from "#sqlite";
import { migrateDatabase } from "./migrations/migrate";
import { seedBaseline } from "./migrations/testing";
import { latestVersion, MIGRATIONS } from "./migrations/registry";

const actor = { name: "Path test", email: null, kind: "human" as const };
const build = { client: "test", version: "1.0.0" };
const PLENTY_OF_SPACE = { availableBytes: 2 ** 40, blockBytes: 4096, device: 1 };

function retarget(link: string, target: string) {
  unlinkSync(link);
  symlinkSync(target, link, "dir");
}

test("relative storage selection keeps its original working-directory base", () => {
  withTestStore((root) => {
    const store = join(root, "store");
    const other = join(root, "other");
    mkdirSync(store);
    mkdirSync(other);
    withEnvironment({ ZINN_DIR: "store" }, () => {
      const before = getStorage();
      process.chdir(other);
      expect(getStorage().databasePath).toBe(before.databasePath);
      project.create({ key: "BASE" }, actor);
      expect(existsSync(join(store, "data", "zinn.sqlite"))).toBe(true);
      expect(readdirSync(other)).toEqual([]);
    }, root);
  });
});

test("opening carries one captured target through preparation and legacy-read callbacks", () => {
  withTestStore((root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    const link = join(root, "selected");
    mkdirSync(join(first, "data"), { recursive: true });
    mkdirSync(second);
    const path = join(first, "data", "zinn.sqlite");
    const unmarked = openDatabase(path);
    seedBaseline(unmarked);
    unmarked.exec("PRAGMA user_version = 0");
    unmarked.close();
    symlinkSync(first, link, "dir");

    withStore(link, () => {
      const facts: Array<DatabaseFacts> = [];
      configureDatabase({ ...build, executable: "path-test", release: "source", allowsLegacyRead: true,
        onLegacyRead: (value) => { facts.push(value); },
      });
      const connect = driver.connect;
      const open = spyOn(driver, "connect").mockImplementation((destination, options) => {
        const connection = connect(destination, options);
        retarget(link, second);
        return connection;
      });
      try {
        expect<string | null>(getDb().databasePath).toBe(realpathSync(path));
        expect(facts).toHaveLength(1);
        expect(facts[0]!.databasePath).toBe(realpathSync(path));
        expect(getStorage().databasePath).not.toBe(realpathSync(path));
      } finally {
        open.mockRestore();
      }
      expect(readdirSync(second)).toEqual([]);
    });
  });
});

test("storage snapshots resolve a fresh destination while an existing connection and reindex retain their target", () => {
  withTestStore((root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    const link = join(root, "selected");
    mkdirSync(first);
    mkdirSync(second);
    withStore(first, () => project.create({ key: "FIRST" }, actor));
    withStore(second, () => project.create({ key: "SECOND" }, actor));
    symlinkSync(first, link, "dir");

    withStore(link, () => {
      const before = getStorage();
      const connection = getDb();
      retarget(link, second);
      const after = getStorage();

      expect(after).not.toBe(before);
      expect(after.directory).toBe(before.directory);
      expect<string>(before.databasePath).toBe(realpathSync(join(first, "data", "zinn.sqlite")));
      expect<string>(after.databasePath).toBe(realpathSync(join(second, "data", "zinn.sqlite")));
      expect(getDb()).toBe(connection);
      expect(project.getAll().map((entry) => entry.key)).toEqual(["FIRST"]);
      expect(reindex.run().databasePath).toBe(before.databasePath);
      expect(before.databasePath).not.toBe(after.databasePath);
    });
  });
});

test("read-only facts retain the connection target after the configured alias changes", () => {
  withTestStore((root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    const link = join(root, "selected");
    mkdirSync(join(first, "data"), { recursive: true });
    mkdirSync(second);
    const path = join(first, "data", "zinn.sqlite");
    const db = openDatabase(path);
    db.exec(`PRAGMA user_version = ${latestVersion(MIGRATIONS) + 1}`);
    db.close();
    symlinkSync(first, link, "dir");

    withStore(link, () => {
      getDb();
      retarget(link, second);
      expect(getStorage().databasePath).not.toBe(realpathSync(path));
      expect(() => assertWritable()).toThrow(expect.objectContaining({
        kind: "conflict",
        facts: expect.objectContaining({ databasePath: realpathSync(path), reason: "newer_database" }),
      }));
      expect(() => reindex.run()).toThrow(expect.objectContaining({
        facts: expect.objectContaining({ databasePath: realpathSync(path) }),
      }));
      expect(readdirSync(second)).toEqual([]);
    });
  });
});

test("migration reports one destination for a relative alias on upgrade and repeated no-op", () => {
  withTestStore((root) => {
    const store = join(root, "store");
    const link = join(root, "selected");
    mkdirSync(store);
    symlinkSync(store, link, "dir");
    const path = join(store, "zinn.sqlite");
    const db = openDatabase(path);
    seedBaseline(db);
    db.close();
    const options = {
      backup: { ...build, directory: join(root, "backups") },
      migrations: [{ version: 2, name: "path check", rebuilds: [], apply(connection: typeof db) {
        connection.exec("CREATE TABLE path_check (value TEXT)");
      } }],
      readFreeSpace: () => PLENTY_OF_SPACE,
    };
    const requested = relative(process.cwd(), join(link, "zinn.sqlite"));
    const upgraded = migrateDatabase(resolveDatabasePath(requested), options);
    const unchanged = migrateDatabase(resolveDatabasePath(requested), options);

    expect(upgraded.databasePath).toBe(realpathSync(path));
    expect(unchanged.databasePath).toBe(upgraded.databasePath);
    expect(upgraded.changed).toBe(true);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.backupPath).toBeNull();
    expect(readdirSync(options.backup.directory)).toHaveLength(1);
  });
});

test("restore uses an explicit destination snapshot after retargeting and captures a fresh one when omitted", () => {
  withTestStore((root) => {
    const source = join(root, "source");
    const first = join(root, "first");
    const second = join(root, "second");
    const link = join(root, "selected");
    for (const directory of [source, first, second]) {
      mkdirSync(directory);
    }
    const saved = withStore(source, () => {
      project.create({ key: "SAVED" }, actor);
      return backup.create(build).path;
    });
    symlinkSync(first, link, "dir");

    withStore(link, () => {
      const storage = getBackupStorage();
      retarget(link, second);
      const invalid = join(root, "invalid.sqlite");
      writeFileSync(invalid, "not a backup");
      expect(() => backup.restore({ ...build, path: invalid, storage })).toThrow();
      expect(readdirSync(first)).toEqual([]);

      const restored = backup.restore({ ...build, path: saved, storage });
      expect(restored.databasePath).toBe(storage.databasePath);
      expect(existsSync(join(second, "data"))).toBe(false);
      expect(getStorage().databasePath).not.toBe(storage.databasePath);

      const fresh = backup.restore({ ...build, path: saved });
      expect(fresh.databasePath).toBe(realpathSync(join(second, "data", "zinn.sqlite")));
      for (const path of [restored.databasePath, fresh.databasePath]) {
        const db = openDatabase(path);
        try {
          expect(db.query("SELECT key FROM project").all()).toEqual([{ key: "SAVED" }]);
        } finally {
          db.close();
        }
      }
    });
  });
});

test("info reports resolved destinations and preserves requested paths when resolution fails", () => {
  withTestStore((root) => {
    const store = join(root, "store");
    const link = join(root, "selected");
    mkdirSync(store);
    symlinkSync(store, link, "dir");
    const inputs = { home: root, cwd: root, env: { ZINN_DIR: link } };
    const report = info.get(inputs);
    expect(report.storage.directory).toBe(link);
    expect(report.database.path).toBe(join(realpathSync(store), "data", "zinn.sqlite"));
    expect(report.database.state).toBe("absent");
    expect(readdirSync(store)).toEqual([]);

    symlinkSync("missing", join(store, "data"), "dir");
    const refused = info.get(inputs);
    expect(refused.storage.directory).toBe(link);
    expect(refused.database.path).toBe(join(link, "data", "zinn.sqlite"));
    expect(refused.database.state).toBe("unavailable");
    expect(refused.database.error).toBeString();
    withStore(link, () => {
      expect(() => getStorage()).toThrow(expect.objectContaining({
        kind: "storage",
        facts: { entity: "database", databasePath: join(link, "data", "zinn.sqlite") },
      } satisfies Partial<CoreError>));
    });
  });
});
