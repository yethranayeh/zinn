import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";

import { LATEST_SCHEMA_VERSION, LATEST_STATEMENTS } from "./latest";
import { latestVersion, MIGRATIONS } from "./registry";
import { createLatestSchema, createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { count, foreignKeys, schemaObjects, snapshot, withDatabase } from "./testing";

/** The schema, version and rows of a database that `create` built. */
function snapshotOf(create: (db: Database) => void) {
  let created!: ReturnType<typeof snapshot>;

  withDatabase((db) => {
    create(db);
    created = snapshot(db);
  });

  return created;
}

/** Runs statements in place of the latest ones and stamps the version. */
function createFrom(
  db: Database,
  statements: ReadonlyArray<string>,
  version = LATEST_SCHEMA_VERSION,
) {
  for (const statement of statements) {
    db.exec(statement);
  }

  db.exec(`PRAGMA user_version = ${version}`);
}

function expectRejection(db: Database, sql: string, code: string) {
  expect(() => db.exec(sql)).toThrow(expect.objectContaining({ code }));
}

/** What the latest schema does with rows, which names and a version alone would not show. */
function expectLatestBehavior(db: Database) {
  db.exec(
    "INSERT INTO project (id, key, name, created_at, updated_at) VALUES ('p1', 'APP', 'App', 1, 1)",
  );
  db.exec("INSERT INTO project_column (id, project_id, name) VALUES ('c1', 'p1', 'Todo')");
  for (const [id, number] of [["t1", 1], ["t2", 2]] as const) {
    db.exec(`INSERT INTO task (id, project_id, column_id, number, title, created_at, updated_at)
      VALUES ('${id}', 'p1', 'c1', ${number}, 'Café', 1, 1)`);
  }
  db.exec(`INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
    VALUES ('r1', 't1', 't2', 'related', 1)`);
  db.exec("INSERT INTO label (id, name, color) VALUES ('l1', 'bug', 'red')");
  db.exec("INSERT INTO task_label (task_id, label_id) VALUES ('t1', 'l1')");
  db.exec(`INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
    VALUES ('m1', 't1', 1, 'one', 1, 1)`);
  db.exec(`INSERT INTO activity (id, created_at, actor_kind, actor_client, entity_type, entity_id, action)
    VALUES ('a1', 1, 'agent', 'test', 'task', 't1', 'create')`);
  db.exec("INSERT INTO task_search (task_id, title, comments) VALUES ('t1', 'Café', 'one')");
  db.exec(`INSERT INTO task_claim (task_id, actor_kind, claimed_at, renewed_at, worked_at, lease_ms)
    VALUES ('t1', 'human', 1, 1, 1, 60000)`);

  // Defaults
  expect(db.query("SELECT task_count FROM project").get()).toEqual({ task_count: 0 });
  expect(db.query("SELECT category FROM project_column").get()).toEqual({ category: "todo" });
  expect(db.query("SELECT comment_count, due_at FROM task WHERE id = 't1'").get()).toEqual({
    comment_count: 0,
    due_at: null,
  });
  expect(db.query("SELECT actor_name, actor_client FROM activity").get()).toEqual({
    actor_name: null,
    actor_client: "test",
  });

  // The tokenizer folds diacritics
  expect(db.query("SELECT task_id FROM task_search WHERE task_search MATCH 'cafe'").all()).toEqual([
    { task_id: "t1" },
  ]);

  // Required columns
  expectRejection(
    db,
    `INSERT INTO task (id, project_id, column_id, number, created_at, updated_at)
      VALUES ('t3', 'p1', 'c1', 3, 1, 1)`,
    "SQLITE_CONSTRAINT_NOTNULL",
  );
  expectRejection(
    db,
    "INSERT INTO project_column (id, project_id, name, category) VALUES ('c2', 'p1', 'Done', NULL)",
    "SQLITE_CONSTRAINT_NOTNULL",
  );

  // Uniqueness
  expectRejection(
    db,
    "INSERT INTO project (id, key, name, created_at, updated_at) VALUES ('p2', 'APP', 'Again', 1, 1)",
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expectRejection(
    db,
    "INSERT INTO label (id, name, color) VALUES ('l2', 'bug', 'blue')",
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expectRejection(
    db,
    `INSERT INTO comment (id, task_id, number, text, created_at, updated_at)
      VALUES ('m2', 't1', 1, 'again', 1, 1)`,
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expectRejection(
    db,
    `INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
      VALUES ('r2', 't1', 't2', 'related', 1)`,
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  expectRejection(
    db,
    "INSERT INTO task_label (task_id, label_id) VALUES ('t1', 'l1')",
    "SQLITE_CONSTRAINT_PRIMARYKEY",
  );

  // The self-relation CHECK
  expectRejection(
    db,
    `INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
      VALUES ('r3', 't1', 't1', 'related', 1)`,
    "SQLITE_CONSTRAINT_CHECK",
  );

  // Foreign keys: a missing parent, and a column that still holds tasks
  expectRejection(
    db,
    "INSERT INTO task_label (task_id, label_id) VALUES ('t2', 'missing')",
    "SQLITE_CONSTRAINT_FOREIGNKEY",
  );
  expectRejection(db, "DELETE FROM project_column", "SQLITE_CONSTRAINT_FOREIGNKEY");

  // Deleting a project removes everything under it and keeps labels
  db.exec("DELETE FROM project");
  for (const table of ["project_column", "task", "task_relations", "task_label", "comment", "task_claim"]) {
    expect({ table, count: count(db, table) }).toEqual({ table, count: 0 });
  }
  expect(count(db, "label")).toBe(1);
}

/** A migration newer than every registered one, with a table rebuild and an added column. */
const laterMigration: Migration = {
  version: latestVersion(MIGRATIONS) + 1,
  name: "test addition",
  rebuilds: ["label"],
  apply(db) {
    db.exec(`CREATE TABLE new_label (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT NOT NULL,
      test_addition TEXT)`);
    db.exec("INSERT INTO new_label (id, name, description, color) SELECT id, name, description, color FROM label");
    db.exec("DROP TABLE label");
    db.exec("ALTER TABLE new_label RENAME TO label");
    db.exec("ALTER TABLE task ADD COLUMN test_addition TEXT");
  },
};
const withLaterMigration = [...MIGRATIONS, laterMigration];

/** Each changes one statement of the latest schema in a way its object names do not show. */
const MISMATCHES = [
  { name: "a column default", from: "DEFAULT 'todo'", to: "DEFAULT 'done'" },
  { name: "a required column", from: "title          TEXT NOT NULL", to: "title          TEXT" },
  { name: "a uniqueness constraint", from: "name TEXT NOT NULL UNIQUE", to: "name TEXT NOT NULL" },
  {
    name: "a foreign key action",
    from: "REFERENCES project_column(id)",
    to: "REFERENCES project_column(id) ON DELETE CASCADE",
  },
  { name: "a missing column", from: ", due_at INTEGER", to: "" },
  { name: "the search tokenizer", from: "remove_diacritics 2", to: "remove_diacritics 0" },
];

test("the latest schema is at the newest registered version", () => {
  expect(LATEST_SCHEMA_VERSION).toBe(latestVersion(MIGRATIONS));
});

test("a database created at the latest schema equals one built from the baseline and every migration", () => {
  const reference = snapshotOf((db) => createSchema(db));

  expect(snapshotOf((db) => createLatestSchema(db))).toEqual(reference);
  expect(reference.version).toBe(latestVersion(MIGRATIONS));
});

for (const [path, create] of [
  ["created at the latest schema", createLatestSchema],
  ["built from the baseline and every migration", createSchema],
] as const) {
  test(`a database ${path} keeps the latest defaults and constraints`, () => {
    withDatabase((db) => {
      create(db);
      expectLatestBehavior(db);
    });
  });
}

for (const mismatch of MISMATCHES) {
  test(`changing ${mismatch.name} fails the comparison and the behavior checks`, () => {
    const reference = snapshotOf((db) => createSchema(db));
    const changed = LATEST_STATEMENTS.map((statement) =>
      statement.replace(mismatch.from, mismatch.to),
    );
    expect(changed).not.toEqual(LATEST_STATEMENTS);
    // Unchanged statements pass, so each failure below comes from the change alone.
    expect(snapshotOf((db) => createFrom(db, LATEST_STATEMENTS))).toEqual(reference);

    withDatabase((db) => {
      createFrom(db, changed);
      expect(() => expect(snapshot(db)).toEqual(reference)).toThrow();
      expect(() => expectLatestBehavior(db)).toThrow();
    });
  });
}

test("a wrong version stamp fails the comparison", () => {
  const reference = snapshotOf((db) => createSchema(db));
  const stamped = snapshotOf((db) => createFrom(db, LATEST_STATEMENTS, LATEST_SCHEMA_VERSION - 1));

  expect(() => expect(stamped).toEqual(reference)).toThrow();
});

test("a migration newer than the latest schema runs on a fresh database", () => {
  const created = snapshotOf((db) => createLatestSchema(db, withLaterMigration));

  expect(created.version).toBe(laterMigration.version);
  expect(created).toEqual(snapshotOf((db) => createSchema(db, withLaterMigration)));
});

test("a database created at the latest schema upgrades with a later migration", () => {
  const upgraded = snapshotOf((db) => {
    createLatestSchema(db);
    upgradeSchema(db, withLaterMigration);
  });

  expect(upgraded).toEqual(snapshotOf((db) => createSchema(db, withLaterMigration)));
});

test("a failed creation at the latest schema leaves the database empty", () => {
  withDatabase((db) => {
    const failure = new Error("planned migration failure");
    const failing: Migration = {
      ...laterMigration,
      apply() {
        throw failure;
      },
    };

    expect(() => createLatestSchema(db, [...MIGRATIONS, failing])).toThrow(failure);
    expect(schemaObjects(db)).toEqual([]);
    expect(readSchemaVersion(db)).toBe(0);
    expect(foreignKeys(db)).toBe(1);
  });
});

test("creation at the latest schema refuses a database that already has a schema", () => {
  withDatabase((db) => {
    createLatestSchema(db);
    const before = snapshot(db);

    expect(() => createLatestSchema(db)).toThrow(
      expect.objectContaining({ name: "SchemaNotEmptyError" }),
    );
    expect(snapshot(db)).toEqual(before);
  });
});

test("creation at the latest schema refuses migrations that end before its version", () => {
  withDatabase((db) => {
    expect(() => createLatestSchema(db, MIGRATIONS.slice(0, -1))).toThrow();
    expect(schemaObjects(db)).toEqual([]);
    expect(readSchemaVersion(db)).toBe(0);
  });
});
