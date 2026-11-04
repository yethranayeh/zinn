import type { Database } from "../sqlite/database";

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "#sqlite";

import { BASELINE_VERSION } from "./baseline";
import { MIGRATIONS } from "./registry";
import { checkBackup } from "./restore";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { applicationSchema, withDatabase, withDirectory } from "./testing";

type SchemaSnapshot = { schemaVersion: number; objects: ReturnType<typeof applicationSchema> };

const SNAPSHOT_DIRECTORY = join(import.meta.dir, "../../testing/schema-snapshots");
const BUILD = { client: "test", version: "1.2.3" };
const registeredVersions = [BASELINE_VERSION, ...MIGRATIONS.map(({ version }) => version)];
const latestVersion = registeredVersions.at(-1)!;

function readSnapshot(version: number): SchemaSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIRECTORY, `v${version}.json`), "utf8"));
}

function expectSnapshot(db: Database, snapshot: SchemaSnapshot) {
  expect(readSchemaVersion(db)).toBe(snapshot.schemaVersion);
  expect(applicationSchema(db)).toEqual(snapshot.objects);
}

/** Replays fixed definitions with tables before their indexes, views and triggers. */
function replaySnapshot(db: Database, snapshot: SchemaSnapshot) {
  for (const type of ["table", "index", "view", "trigger"]) {
    for (const object of snapshot.objects.filter((object) => object.type === type)) {
      db.exec(object.sql);
    }
  }

  db.exec(`PRAGMA user_version = ${snapshot.schemaVersion}`);
}

test("a snapshot exists for exactly the registered schema versions", () => {
  const snapshotVersions = readdirSync(SNAPSHOT_DIRECTORY)
    .map((name) => /^v(\d+)\.json$/.exec(name)?.[1])
    .filter((version) => version !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  expect(snapshotVersions).toEqual(registeredVersions);
});

for (const version of registeredVersions) {
  test(`creating schema v${version} matches its snapshot`, () => {
    withDatabase((db) => {
      createSchema(
        db,
        MIGRATIONS.filter((migration) => migration.version <= version),
      );
      expectSnapshot(db, readSnapshot(version));
    });
  });

  test(`a schema v${version} backup is recognized`, () => {
    withDirectory((directory) => {
      const path = join(directory, "backup.sqlite");
      const snapshot = readSnapshot(version);
      const db = openDatabase(path);
      try {
        replaySnapshot(db, snapshot);
        expectSnapshot(db, snapshot);
      } finally {
        db.close();
      }

      expect(checkBackup(path, MIGRATIONS, BUILD).version).toBe(version);
    });
  });
}

for (const version of registeredVersions.filter((version) => version < latestVersion)) {
  test(`a schema v${version} database upgrades to the latest snapshot`, () => {
    withDatabase((db) => {
      replaySnapshot(db, readSnapshot(version));
      upgradeSchema(db);
      expectSnapshot(db, readSnapshot(latestVersion));
    });
  });
}

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
  test(`changing ${change.name} breaks the snapshot match`, () => {
    const snapshot = readSnapshot(BASELINE_VERSION);
    const changed = {
      ...snapshot,
      objects: snapshot.objects.map((object) => ({
        ...object,
        sql: object.sql.replace(change.from, change.to),
      })),
    };
    expect(changed.objects).not.toEqual(snapshot.objects);

    withDatabase((db) => {
      replaySnapshot(db, changed);
      expect(() => expectSnapshot(db, snapshot)).toThrow();
    });
  });
}

test("snapshots hold declared objects and leave out generated storage", () => {
  withDatabase((db) => {
    db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE)");
    db.exec("CREATE INDEX item_value ON item(value)");
    db.exec("CREATE VIEW item_view AS SELECT value FROM item");
    db.exec("CREATE TRIGGER item_insert AFTER INSERT ON item BEGIN SELECT 1; END");
    db.exec("CREATE TRIGGER item_view_insert INSTEAD OF INSERT ON item_view BEGIN SELECT 1; END");
    db.exec("CREATE VIRTUAL TABLE search USING fts5(value)");
    db.exec("CREATE INDEX search_content_value ON search_content(c0)");
    db.exec("CREATE TABLE search_extra (value TEXT)");

    expect(applicationSchema(db).map(({ type, name }) => `${type} ${name}`)).toEqual([
      "index item_value",
      "index search_content_value",
      "table item",
      "table search",
      "table search_extra",
      "trigger item_insert",
      "trigger item_view_insert",
      "view item_view",
    ]);
  });
});
