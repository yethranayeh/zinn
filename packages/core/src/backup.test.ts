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
      import { existsSync, readFileSync } from "node:fs";
      import { basename } from "node:path";
      import { backup } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
      import { DB_PATH } from ${JSON.stringify(new URL("./constant.ts", import.meta.url).pathname)};

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
