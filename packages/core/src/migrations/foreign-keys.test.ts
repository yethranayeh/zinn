import { expect, test } from "bun:test";
import type { Database } from "../sqlite/database";
import type { ForeignKeyDefinition, Migration } from "./registry";
import { readSchemaVersion, upgradeSchema } from "./runner";
import { count, foreignKeys, seedBaseline, snapshot, withDatabase } from "./testing";

function step(apply: Migration["apply"], options: Partial<Migration> = {}): Migration {
  return { version: 2, name: "verify foreign keys", rebuilds: [], apply, ...options };
}

function expectRollback(db: Database, migration: Migration, facts: string[]) {
  const before = snapshot(db);
  let failure: unknown;
  try {
    upgradeSchema(db, [migration]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  for (const fact of [String(migration.version), migration.name, ...facts]) {
    expect((failure as Error).message).toContain(fact);
  }
  expect(snapshot(db)).toEqual(before);
  expect(foreignKeys(db)).toBe(1);
  expect(db.inTransaction).toBe(false);
}

test.each([false, true])("ZINN-405: a parent rename cannot silently retarget an untouched child (empty: %p)", (empty) => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("PRAGMA legacy_alter_table = OFF");
    if (empty) {
      db.exec("DELETE FROM task_label");
    }
    const unsafe = step((db) => {
      db.exec("ALTER TABLE label RENAME TO label_old");
      db.exec("CREATE TABLE label (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, color TEXT NOT NULL)");
      db.exec("INSERT INTO label SELECT id, name, description, color FROM label_old");
      expect(count(db, "label")).toBe(2);
      expect(count(db, "task_label")).toBe(empty ? 0 : 2);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }, { rebuilds: ["label"] });

    expectRollback(db, unsafe, ["task_label", "label_id", "label_old"]);
  });
});

const original: ForeignKeyDefinition = {
  table: "label",
  columns: [{ from: "parent_id", to: "id" }],
  onUpdate: "NO ACTION",
  onDelete: "CASCADE",
};

function createChild(db: Database, clause = "parent_id TEXT REFERENCES label(id) ON DELETE CASCADE") {
  db.exec(`CREATE TABLE child (id TEXT PRIMARY KEY, ${clause})`);
  db.exec("INSERT INTO child (id, parent_id) VALUES ('child1', 'l1')");
}

function rebuildChild(db: Database, clause: string) {
  db.exec(`CREATE TABLE new_child (id TEXT PRIMARY KEY, ${clause})`);
  db.exec("INSERT INTO new_child (id, parent_id) SELECT id, parent_id FROM child");
  db.exec("DROP TABLE child");
  db.exec("ALTER TABLE new_child RENAME TO child");
}

test("declared complete definitions allow an intentional change and enforce its resulting action", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    const updated = { ...original, onDelete: "SET NULL" };
    const change = step((db) => rebuildChild(db, "parent_id TEXT REFERENCES label(id) ON DELETE SET NULL"), {
      rebuilds: ["child"],
      foreignKeyChanges: { child: { before: [original], after: [updated] } },
    });

    upgradeSchema(db, [change]);

    expect(readSchemaVersion(db)).toBe(2);
    expect(count(db, "child")).toBe(1);
    db.exec("DELETE FROM label WHERE id = 'l1'");
    expect(db.query("SELECT parent_id FROM child").get()).toEqual({ parent_id: null });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

test("a stale starting expectation aborts before the migration is applied", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    let applied = false;
    const stale = step(() => { applied = true; }, {
      foreignKeyChanges: { child: { before: [{ ...original, table: "project" }], after: [] } },
    });

    expectRollback(db, stale, ["child", "project", "label"]);
    expect(applied).toBe(false);
  });
});

test("a declared change must match the result even when the migration does nothing", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    expectRollback(db, step(() => {}, {
      foreignKeyChanges: { child: { before: [original], after: [] } },
    }), ["child", "parent_id"]);
  });
});

test("case aliases cannot overwrite a table's declared expectations", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    let applied = false;
    expectRollback(db, step(() => { applied = true; }, {
      foreignKeyChanges: {
        child: { before: [original], after: [] },
        CHILD: { before: [original], after: [original] },
      },
    }), ["CHILD"]);
    expect(applied).toBe(false);
  });
});

test("an extra accidental change on a declared table still aborts", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    const change = step((db) => rebuildChild(db,
      "parent_id TEXT REFERENCES label(id) ON DELETE SET NULL, extra_id TEXT REFERENCES project(id)"), {
      rebuilds: ["child"],
      foreignKeyChanges: { child: { before: [original], after: [{ ...original, onDelete: "SET NULL" }] } },
    });

    expectRollback(db, change, ["child", "extra_id", "project"]);
  });
});

test.each([
  ["referenced table", "parent_id TEXT REFERENCES project(id) ON DELETE CASCADE", "project"],
  ["source column", "parent_id TEXT, other_id TEXT REFERENCES label(id) ON DELETE CASCADE", "other_id"],
  ["target column", "parent_id TEXT REFERENCES label(name) ON DELETE CASCADE", "name"],
  ["update action", "parent_id TEXT REFERENCES label(id) ON UPDATE CASCADE ON DELETE CASCADE", "CASCADE"],
  ["delete action", "parent_id TEXT REFERENCES label(id) ON DELETE SET NULL", "SET NULL"],
  ["removed key", "parent_id TEXT", "parent_id"],
  ["added key", "parent_id TEXT REFERENCES label(id) ON DELETE CASCADE, extra_id TEXT REFERENCES project(id)", "extra_id"],
])("undeclared changes to a %s abort even with no child rows", (_name, clause, fact) => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    db.exec("DELETE FROM child");
    expectRollback(db, step((db) => rebuildChild(db, clause), { rebuilds: ["child"] }), ["child", fact]);
  });
});

test("a foreign key added to a previously unreferencing table is checked", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db, "parent_id TEXT");
    expectRollback(db, step((db) => rebuildChild(db, "parent_id TEXT REFERENCES label(id)")), ["child", "label"]);
  });
});

test("a declared change does not permit changes in another table", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    const change = step((db) => {
      rebuildChild(db, "parent_id TEXT REFERENCES label(id) ON DELETE SET NULL");
      db.exec("ALTER TABLE task_label ADD COLUMN extra_id TEXT REFERENCES project(id)");
    }, {
      foreignKeyChanges: { child: { before: [original], after: [{ ...original, onDelete: "SET NULL" }] } },
    });
    expectRollback(db, change, ["task_label", "extra_id"]);
  });
});

test("each step is checked before a later step can hide its change", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    const before = snapshot(db);
    let laterApplied = false;
    expect(() => upgradeSchema(db, [
      step((db) => rebuildChild(db, "parent_id TEXT")),
      step(() => { laterApplied = true; }, { version: 3 }),
    ])).toThrow();
    expect(laterApplied).toBe(false);
    expect(snapshot(db)).toEqual(before);
  });
});

test("a failing later step rolls back a valid declared change too", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    const before = snapshot(db);
    const failure = new Error("later migration failure");
    expect(() => upgradeSchema(db, [
      step((db) => rebuildChild(db, "parent_id TEXT"), {
        foreignKeyChanges: { child: { before: [original], after: [] } },
      }),
      step(() => { throw failure; }, { version: 3 }),
    ])).toThrow(failure);
    expect(snapshot(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
    expect(db.inTransaction).toBe(false);
  });
});

test("a dropped table requires a declaration for its removed foreign keys", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db);
    expectRollback(db, step((db) => db.exec("DROP TABLE child")), ["child", "label"]);
    upgradeSchema(db, [step((db) => db.exec("DROP TABLE child"), {
      foreignKeyChanges: { child: { before: [original], after: [] } },
    })]);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'child'").get()).toBeNull();
    expect(readSchemaVersion(db)).toBe(2);
  });
});

test("equivalent key declaration order, quoting and ASCII identifier case preserve definitions", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db, "parent_id TEXT REFERENCES label(id) ON DELETE CASCADE, project_id TEXT REFERENCES project(id)");
    const rowsBefore = db.query("SELECT * FROM pragma_foreign_key_list('child')").all();
    upgradeSchema(db, [step((db) => rebuildChild(db,
      'project_id TEXT REFERENCES "PROJECT"("ID"), parent_id TEXT REFERENCES "LABEL"("ID") ON DELETE CASCADE'))]);
    const rowsAfter = db.query("SELECT * FROM pragma_foreign_key_list('child')").all();
    expect(rowsAfter).not.toEqual(rowsBefore);
    expect(readSchemaVersion(db)).toBe(2);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

test("composite column order and grouping are preserved", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec("CREATE TABLE composite_parent (a TEXT, b TEXT, PRIMARY KEY (a, b), UNIQUE (b, a))");
    createChild(db, "parent_id TEXT, a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES composite_parent(a, b)");
    expectRollback(db, step((db) => rebuildChild(db,
      "parent_id TEXT, a TEXT, b TEXT, FOREIGN KEY (b, a) REFERENCES composite_parent(a, b)")), ["child", "composite_parent"]);
    expectRollback(db, step((db) => rebuildChild(db,
      "parent_id TEXT, a TEXT, b TEXT, FOREIGN KEY (a) REFERENCES composite_parent(a), FOREIGN KEY (b) REFERENCES composite_parent(b)")), ["child", "composite_parent"]);
    upgradeSchema(db, [step((db) => rebuildChild(db,
      "parent_id TEXT, a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES composite_parent(a, b)"))]);
    expect(readSchemaVersion(db)).toBe(2);
  });
});

test("duplicate constraints are counted and implicit parent columns remain null", () => {
  withDatabase((db) => {
    seedBaseline(db);
    createChild(db, "parent_id TEXT REFERENCES label");
    expectRollback(db, step((db) => rebuildChild(db,
      "parent_id TEXT REFERENCES label, FOREIGN KEY (parent_id) REFERENCES label")), ["child", "label"]);
    const implicit = { ...original, columns: [{ from: "parent_id", to: null }], onDelete: "NO ACTION" };
    upgradeSchema(db, [step((db) => rebuildChild(db, "parent_id TEXT"), {
      foreignKeyChanges: { child: { before: [implicit], after: [] } },
    })]);
    expect(readSchemaVersion(db)).toBe(2);
  });
});

test("SQLite identifier folding does not equate distinct non-ASCII names", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.exec('CREATE TABLE "Ä" (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE "ä" (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES "Ä"(id))');
    expectRollback(db, step((db) => rebuildChild(db, 'parent_id TEXT REFERENCES "ä"(id)')), ["child", "Ä", "ä"]);
  });
});

test("new tables can declare references to a parent added by a later step", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, [
      step((db) => db.exec("CREATE TABLE new_child (parent_id TEXT REFERENCES new_parent)")),
      step((db) => db.exec("CREATE TABLE new_parent (id TEXT PRIMARY KEY)"), { version: 3 }),
    ]);
    expect(readSchemaVersion(db)).toBe(3);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
