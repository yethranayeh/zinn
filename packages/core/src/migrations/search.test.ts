import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";

import { SEARCH_COMMENT_SEPARATOR } from "../search-entry";
import { readSchemaVersion, createSchema, upgradeSchema } from "./runner";
import { regenerateSearch } from "./search";
import { count, schemaObjects, seedBaseline, withDatabase } from "./testing";

const SOURCE_TABLES = [
  "project",
  "project_column",
  "task",
  "task_relations",
  "label",
  "task_label",
  "comment",
  "activity",
];

function regeneratingMigration(apply = regenerateSearch): Migration {
  return { version: 2, name: "regenerate search", rebuilds: [], regeneratesSearch: true, apply };
}

function sourceRows(db: Database) {
  return Object.fromEntries(
    SOURCE_TABLES.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function searchRows(db: Database) {
  return db
    .query("SELECT task_id, title, description, comments FROM task_search ORDER BY task_id")
    .all();
}

function matches(db: Database, match: string) {
  return db
    .query<{ task_id: string }>("SELECT task_id FROM task_search WHERE task_search MATCH $match ORDER BY task_id")
    .all({ $match: match })
    .map((row) => row.task_id);
}

/** seedBaseline joins comments with a space instead of the separator. */
function seedWithArchivedTask(db: Database) {
  seedBaseline(db);
  db.exec(`
    UPDATE task SET archived_at = 11 WHERE id = 't3';
    UPDATE task SET description = 'Café notes' WHERE id = 't2';
    INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('m4', 't3', 1, 'archived zebra', 12, 12);
  `);
}

test("regeneration removes the cross-comment phrase match and makes archived tasks searchable", () => {
  withDatabase((db) => {
    seedWithArchivedTask(db);

    expect(matches(db, '"one two"')).toEqual(["t1"]);
    expect(matches(db, "zebra")).toEqual([]);

    upgradeSchema(db, [regeneratingMigration()]);

    expect(matches(db, '"one two"')).toEqual([]);
    expect(matches(db, "one AND two")).toEqual(["t1"]);
    expect(matches(db, "zebra")).toEqual(["t3"]);
    expect(matches(db, "cafe")).toEqual(["t2"]);
    expect(searchRows(db)).toEqual([
      { task_id: "t1", title: "First", description: null, comments: `one${SEARCH_COMMENT_SEPARATOR}two` },
      { task_id: "t2", title: "Second", description: "Café notes", comments: "three" },
      { task_id: "t3", title: "Third", description: null, comments: "archived zebra" },
    ]);
  });
});

test("a fresh database and a store that skips the version end in the same state", () => {
  withDatabase((upgraded) => {
    seedBaseline(upgraded);
    upgradeSchema(upgraded, [regeneratingMigration()]);

    withDatabase((fresh) => {
      createSchema(fresh, [regeneratingMigration()]);

      expect(readSchemaVersion(upgraded)).toBe(2);
      expect(readSchemaVersion(fresh)).toBe(2);
      expect(schemaObjects(upgraded)).toEqual(schemaObjects(fresh));
      expect(count(fresh, "task_search")).toBe(0);
    });
  });
});

test("regeneration leaves source rows, IDs, timestamps, allocators and activity unchanged", () => {
  withDatabase((db) => {
    seedWithArchivedTask(db);
    const before = sourceRows(db);

    upgradeSchema(db, [regeneratingMigration()]);

    expect(sourceRows(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

test("the FTS5 integrity-check passes after regeneration", () => {
  withDatabase((db) => {
    seedWithArchivedTask(db);
    upgradeSchema(db, [regeneratingMigration()]);

    expect(() => db.exec("INSERT INTO task_search (task_search) VALUES ('integrity-check')")).not.toThrow();
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });
});

test("a failure partway through filling aborts the upgrade and restores the old version and index", () => {
  withDatabase((db) => {
    seedWithArchivedTask(db);
    const before = {
      version: readSchemaVersion(db),
      schema: schemaObjects(db),
      source: sourceRows(db),
      search: searchRows(db),
    };
    const failure = new Error("planned failure while filling the index");
    let inserts = 0;

    // Fails the second insert, after the old index is dropped.
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "query") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }

        return (sql: string) => {
          const statement = target.query(sql);

          if (!sql.startsWith("INSERT INTO task_search")) {
            return statement;
          }

          return {
            ...statement,
            run(...args: Array<never>) {
              inserts++;
              if (inserts === 2) {
                throw failure;
              }

              return statement.run(...args);
            },
          };
        };
      },
    });

    expect(() => upgradeSchema(db, [regeneratingMigration(() => regenerateSearch(failingDb))])).toThrow(
      failure,
    );

    expect(inserts).toBe(2);
    expect(readSchemaVersion(db)).toBe(before.version);
    expect(schemaObjects(db)).toEqual(before.schema);
    expect(sourceRows(db)).toEqual(before.source);
    expect(searchRows(db)).toEqual(before.search);
    expect(matches(db, '"one two"')).toEqual(["t1"]);
  });
});
