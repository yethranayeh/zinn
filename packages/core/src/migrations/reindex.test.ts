import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";
import type { FreeSpace } from "./space";

import { expect, test } from "bun:test";

import { openDatabase } from "#sqlite";

import { SEARCH_COMMENT_SEPARATOR } from "../search-entry";
import { reindexSearch } from "./reindex";
import { readSchemaVersion, upgradeSchema } from "./runner";
import { latestVersion, MIGRATIONS } from "./registry";
import { regenerateSearch } from "./search";
import { readDatabaseFile } from "./space";
import { seedBaseline, snapshot, withDatabase } from "./testing";

const PLENTY_OF_SPACE: FreeSpace = { availableBytes: 2 ** 40, blockBytes: 4096, device: 1 };
const NO_SPACE: FreeSpace = { availableBytes: 0, blockBytes: 4096, device: 1 };
const SHORT_BUDGET_MS = 150;
// Enough long titles that the rebuilt index needs more pages than the database has.
const BULK_TASKS = 200;

const options = { readFreeSpace: () => PLENTY_OF_SPACE };
const CURRENT_VERSION = latestVersion(MIGRATIONS);

function searchRows(db: Database) {
  return db
    .query("SELECT task_id, title, description, comments FROM task_search ORDER BY task_id")
    .all();
}

function matches(db: Database, match: string) {
  return db
    .query<{ task_id: string }>(
      "SELECT task_id FROM task_search WHERE task_search MATCH $match ORDER BY task_id",
    )
    .all({ $match: match })
    .map((row) => row.task_id);
}

/** Every table but the search index and the tables SQLite keeps behind it. */
function sourceRows(db: Database) {
  return Object.fromEntries(
    Object.entries(snapshot(db).rows).filter(([table]) => !table.startsWith("task_search")),
  );
}

function expectSearchHealthy(db: Database) {
  expect(() =>
    db.exec("INSERT INTO task_search (task_search) VALUES ('integrity-check')"),
  ).not.toThrow();
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
}

/** seedBaseline's index joins t1's comments without the separator and has no entry for t3. */
function seedStaleIndex(db: Database) {
  seedBaseline(db);
  upgradeSchema(db);
  db.exec(`
    UPDATE task SET archived_at = 11 WHERE id = 't3';
    INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('m4', 't3', 1, 'archived zebra', 12, 12);
    INSERT INTO task_search (task_id, title, description, comments)
      VALUES ('gone', 'Deleted task', NULL, 'orphan');
  `);
}

test("reindex rebuilds a stale index from the task and comment records, archived tasks included", () => {
  withDatabase((db) => {
    seedStaleIndex(db);
    const source = sourceRows(db);

    expect(matches(db, '"one two"')).toEqual(["t1"]);
    expect(matches(db, "zebra")).toEqual([]);
    expect(matches(db, "orphan")).toEqual(["gone"]);

    const result = reindexSearch(db, options);

    expect(result).toEqual({ databasePath: readDatabaseFile(db)!, taskCount: 3 });
    expect(searchRows(db)).toEqual([
      {
        task_id: "t1",
        title: "First",
        description: null,
        comments: `one${SEARCH_COMMENT_SEPARATOR}two`,
      },
      { task_id: "t2", title: "Second", description: null, comments: "three" },
      { task_id: "t3", title: "Third", description: null, comments: "archived zebra" },
    ]);
    expect(matches(db, '"one two"')).toEqual([]);
    expect(matches(db, "zebra")).toEqual(["t3"]);
    expect(matches(db, "orphan")).toEqual([]);
    expect(sourceRows(db)).toEqual(source);
    expect(readSchemaVersion(db)).toBe(CURRENT_VERSION);
    expectSearchHealthy(db);
  });
});

test("reindex recreates a missing index instead of leaving it empty", () => {
  withDatabase((db) => {
    seedStaleIndex(db);
    db.exec("DROP TABLE task_search");
    const source = sourceRows(db);

    expect(reindexSearch(db, options).taskCount).toBe(3);
    expect(matches(db, "first OR second OR third")).toEqual(["t1", "t2", "t3"]);
    expect(sourceRows(db)).toEqual(source);
    expectSearchHealthy(db);
  });
});

test("a database at another version than this build's latest is refused and left unchanged", () => {
  const regenerating: Migration = {
    version: CURRENT_VERSION + 1,
    name: "regenerate search",
    rebuilds: [],
    regeneratesSearch: true,
    apply: regenerateSearch,
  };

  withDatabase((db) => {
    seedStaleIndex(db);
    const before = snapshot(db);

    // Older: this build would regenerate with the next version's layout.
    expect(() => reindexSearch(db, { ...options, migrations: [...MIGRATIONS, regenerating] })).toThrow(
      `has schema version ${CURRENT_VERSION}, and this build rebuilds the search index only at version ${regenerating.version}. It was left unchanged`,
    );

    // Newer: another process upgraded it with a newer build.
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION + 1}`);
    const newer = snapshot(db);
    expect(() => reindexSearch(db, options)).toThrow(`has schema version ${CURRENT_VERSION + 1}`);
    expect(snapshot(db)).toEqual(newer);
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
    expect(snapshot(db)).toEqual(before);
  });
});

test("too little free space stops the reindex before it writes", () => {
  withDatabase((db) => {
    seedStaleIndex(db);
    const before = snapshot(db);

    expect(() => reindexSearch(db, { readFreeSpace: () => NO_SPACE })).toThrow(
      "Not enough free disk space",
    );
    expect(snapshot(db)).toEqual(before);
  });
});

test("a full database partway through filling the index rolls back to the old index", () => {
  withDatabase((db) => {
    seedStaleIndex(db);
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BULK_TASKS})
      INSERT INTO task (id, project_id, column_id, number, title, comment_count, created_at, updated_at)
        SELECT 'bulk' || i, 'p1', 'c1', 100 + i, 'bulk ' || hex(randomblob(300)), 0, 1, 1 FROM n;
    `);
    const pages = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
    db.exec(`PRAGMA max_page_count = ${pages}`);
    const before = snapshot(db);

    expect(() => reindexSearch(db, options)).toThrow("full");

    expect(snapshot(db)).toEqual(before);
    expect(matches(db, '"one two"')).toEqual(["t1"]);
    expectSearchHealthy(db);
  });
});

test("a reindex that waits out its budget for another writer names itself and changes nothing", () => {
  withDatabase((db) => {
    seedStaleIndex(db);
    const before = snapshot(db);
    const other = openDatabase(readDatabaseFile(db)!);

    try {
      other.exec("BEGIN IMMEDIATE");
      expect(() => reindexSearch(db, { ...options, budgetMs: SHORT_BUDGET_MS })).toThrow(
        "so this reindex stopped and applied no changes",
      );
      other.exec("ROLLBACK");
    } finally {
      other.close();
    }

    expect(snapshot(db)).toEqual(before);
  });
});
