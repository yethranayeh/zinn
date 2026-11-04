import type { Database, OpenOptions } from "../src/sqlite/database.ts";
import type { SchemaObject } from "./schema-objects.ts";

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE_VERSION } from "../src/migrations/baseline.ts";
import { MIGRATIONS } from "../src/migrations/registry.ts";
import { createSchema, readSchemaVersion } from "../src/migrations/runner.ts";
import { checkBackup } from "../src/migrations/restore.ts";
import { applicationSchema } from "./schema-objects.ts";

export type SchemaSnapshot = {
  schemaVersion: number;
  packageVersion: string;
  sourceCommit: string;
  pendingSchemaInputs?: Array<{ path: string; sha256: string | null }>;
  objects: Array<SchemaObject>;
};

type Adapter = { openDatabase(path: string, options?: OpenOptions): Database };
type DefineTest = (name: string, check: () => void) => unknown;

const snapshotDirectory = fileURLToPath(new URL("./schema-snapshots/", import.meta.url));
const registeredVersions = [BASELINE_VERSION, ...MIGRATIONS.map(({ version }) => version)];

export function readSchemaSnapshot(version: number, directory = snapshotDirectory): SchemaSnapshot {
  const snapshot = JSON.parse(
    readFileSync(join(directory, `v${version}.json`), "utf8"),
  ) as SchemaSnapshot;

  assert.equal(snapshot.schemaVersion, version);
  assert.match(snapshot.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(snapshot.packageVersion.length > 0);

  return snapshot;
}

export function assertSchemaSnapshot(db: Database, snapshot: SchemaSnapshot) {
  assert.equal(readSchemaVersion(db), snapshot.schemaVersion);
  assert.deepEqual(applicationSchema(db), snapshot.objects);
}

/** Replays fixed definitions with tables before their indexes, views and triggers. */
export function replaySchemaSnapshot(db: Database, snapshot: SchemaSnapshot) {
  for (const type of ["table", "index", "view", "trigger"]) {
    for (const object of snapshot.objects.filter((object) => object.type === type)) {
      db.exec(object.sql);
    }
  }

  db.exec(`PRAGMA user_version = ${snapshot.schemaVersion}`);
}

function withDatabase(adapter: Adapter, check: (db: Database) => void) {
  const db = adapter.openDatabase(":memory:");

  try {
    check(db);
  } finally {
    db.close();
  }
}

function withDirectory(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-schema-pins-"));

  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function defineSchemaPinChecks(test: DefineTest, adapter: Adapter) {
  for (const version of registeredVersions) {
    test(`schema v${version} matches its fixed historical definitions`, () => {
      const snapshot = readSchemaSnapshot(version);
      withDatabase(adapter, (db) => {
        createSchema(
          db,
          MIGRATIONS.filter((migration) => migration.version <= version),
        );
        assertSchemaSnapshot(db, snapshot);
      });
    });

    test(`historical schema v${version} reconstructs a recognized backup`, () => {
      const snapshot = readSchemaSnapshot(version);
      withDirectory((directory) => {
        const path = join(directory, "historical.sqlite");
        const db = adapter.openDatabase(path);
        try {
          replaySchemaSnapshot(db, snapshot);
          assertSchemaSnapshot(db, snapshot);
        } finally {
          db.close();
        }
        const checked = checkBackup(path, MIGRATIONS, {
          client: "schema-pin-test",
          version: snapshot.packageVersion,
        });
        assert.equal(checked.version, version);
        assert.equal(checked.path, path);
      });
    });
  }

  test("schema pins require a file for every registered version", () => {
    withDirectory((directory) => {
      for (const version of registeredVersions) {
        assert.throws(
          () => readSchemaSnapshot(version, directory),
          (error: unknown) => {
            assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
            assert.equal(
              (error as NodeJS.ErrnoException).path,
              join(directory, `v${version}.json`),
            );
            return true;
          },
        );
      }
    });
  });

  for (const change of [
    {
      name: "a required column constraint",
      from: "key         TEXT NOT NULL UNIQUE",
      to: "key         TEXT UNIQUE",
    },
    {
      name: "an FTS tokenizer option",
      from: "unicode61 remove_diacritics 2",
      to: "unicode61 remove_diacritics 1",
    },
  ]) {
    test(`schema pins reject a historical database after changing ${change.name}`, () => {
      const snapshot = readSchemaSnapshot(BASELINE_VERSION);
      const changed = {
        ...snapshot,
        objects: snapshot.objects.map((object) => ({
          ...object,
          sql: object.sql.replace(change.from, change.to),
        })),
      };
      assert.notDeepEqual(changed.objects, snapshot.objects);
      withDatabase(adapter, (db) => {
        replaySchemaSnapshot(db, changed);
        assert.throws(() => assertSchemaSnapshot(db, snapshot), assert.AssertionError);
      });
    });
  }

  test("schema pins include explicit objects and exclude generated storage", () => {
    withDatabase(adapter, (db) => {
      db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE)");
      db.exec("CREATE INDEX item_value ON item(value)");
      db.exec("CREATE VIEW item_view AS SELECT value FROM item");
      db.exec("CREATE TRIGGER item_insert AFTER INSERT ON item BEGIN SELECT 1; END");
      db.exec("CREATE TRIGGER item_view_insert INSTEAD OF INSERT ON item_view BEGIN SELECT 1; END");
      db.exec("CREATE VIRTUAL TABLE search USING fts5(value)");
      db.exec("CREATE TABLE search_extra (value TEXT)");
      assert.deepEqual(
        applicationSchema(db).map(({ type, name, tbl_name }) => ({ type, name, tbl_name })),
        [
          { type: "index", name: "item_value", tbl_name: "item" },
          { type: "table", name: "item", tbl_name: "item" },
          { type: "table", name: "search", tbl_name: "search" },
          { type: "table", name: "search_extra", tbl_name: "search_extra" },
          { type: "trigger", name: "item_insert", tbl_name: "item" },
          { type: "trigger", name: "item_view_insert", tbl_name: "item_view" },
          { type: "view", name: "item_view", tbl_name: "item_view" },
        ],
      );
      const snapshot = { ...readSchemaSnapshot(BASELINE_VERSION), objects: applicationSchema(db) };
      withDatabase(adapter, (replayed) => {
        replaySchemaSnapshot(replayed, snapshot);
        assertSchemaSnapshot(replayed, snapshot);
      });
    });
  });
}
