import type { Database } from "../sqlite/database";

import { expect, test } from "bun:test";

import { createSchema } from "./runner";
import { schemaObjects, withDatabase, withDirectory } from "./testing";

/** Inserts a row with the given column values. */
function insert(
  db: Database,
  table: string,
  row: Record<string, string | number | null>,
) {
  const columns = Object.keys(row).join(", ");
  const placeholders = Object.keys(row).map(() => "?").join(", ");

  db.query(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`).run(...Object.values(row));
}

function seedParents(db: Database) {
  insert(db, "project", {
    id: "p1",
    key: "APP",
    name: "App",
    created_at: 1,
    updated_at: 1,
  });
  insert(db, "project_column", { id: "c1", project_id: "p1", name: "Todo" });
  for (const id of ["t1", "t2"]) {
    insert(db, "task", {
      id,
      project_id: "p1",
      column_id: "c1",
      number: id === "t1" ? 1 : 2,
      title: id,
      created_at: 1,
      updated_at: 1,
    });
  }
}

test("a fresh database has no vocabulary CHECK, only the self-relation CHECK", () => {
  withDatabase((db) => {
    createSchema(db, []);

    const checks = schemaObjects(db).flatMap(({ name, sql }) =>
      (sql ?? "").includes("CHECK") ? [name] : [],
    );
    expect(checks).toEqual(["task_relations"]);

    const relationSql = schemaObjects(db).find(
      ({ name }) => name === "task_relations",
    )!.sql!;
    expect(relationSql.match(/CHECK/g)).toHaveLength(1);
    expect(relationSql).toContain("CHECK (source_task_id <> target_task_id)");
  });
});

test("SQL accepts values outside each vocabulary", () => {
  withDatabase((db) => {
    createSchema(db, []);
    seedParents(db);

    insert(db, "task", {
      id: "t3",
      project_id: "p1",
      column_id: "c1",
      number: 3,
      title: "odd",
      priority: "someday",
      created_at: 1,
      updated_at: 1,
    });
    insert(db, "task_relations", {
      id: "r1",
      source_task_id: "t1",
      target_task_id: "t2",
      relation_type: "blocks",
      created_at: 1,
    });
    insert(db, "label", { id: "l1", name: "odd", color: "purple" });
    insert(db, "activity", {
      id: "a1",
      created_at: 1,
      actor_name: "x",
      actor_kind: "robot",
      entity_type: "comment",
      entity_id: "t1",
      action: "explode",
    });

    expect(db.query("SELECT priority FROM task WHERE id = 't3'").get()).toEqual(
      { priority: "someday" },
    );
    expect(db.query("SELECT relation_type FROM task_relations").get()).toEqual({
      relation_type: "blocks",
    });
    expect(db.query("SELECT color FROM label").get()).toEqual({
      color: "purple",
    });
    expect(
      db.query("SELECT actor_kind, entity_type, action FROM activity").get(),
    ).toEqual({
      actor_kind: "robot",
      entity_type: "comment",
      action: "explode",
    });
  });
});

test("structural constraints still reject", () => {
  withDatabase((db) => {
    createSchema(db, []);
    seedParents(db);

    const relation = {
      source_task_id: "t1",
      target_task_id: "t2",
      relation_type: "related",
      created_at: 1,
    };
    insert(db, "task_relations", { id: "r1", ...relation });
    insert(db, "label", { id: "l1", name: "bug", color: "red" });

    // The self-relation CHECK
    expect(() =>
      insert(db, "task_relations", {
        id: "r2",
        ...relation,
        target_task_id: "t1",
      }),
    ).toThrow(/CHECK constraint failed/);
    // UNIQUE (source_task_id, target_task_id, relation_type)
    expect(() =>
      insert(db, "task_relations", { id: "r3", ...relation }),
    ).toThrow(/UNIQUE constraint failed/);
    // Label name uniqueness
    expect(() =>
      insert(db, "label", { id: "l2", name: "bug", color: "blue" }),
    ).toThrow(/UNIQUE constraint failed/);
    // NOT NULL on a vocabulary column and on another column
    expect(() =>
      insert(db, "label", { id: "l3", name: "none", color: null }),
    ).toThrow(/NOT NULL constraint failed/);
    expect(() =>
      insert(db, "task", {
        id: "t9",
        project_id: "p1",
        column_id: "c1",
        number: 9,
        created_at: 1,
        updated_at: 1,
      }),
    ).toThrow(/NOT NULL constraint failed/);
    // Foreign keys
    expect(() =>
      insert(db, "task_relations", {
        id: "r4",
        ...relation,
        target_task_id: "missing",
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      insert(db, "task_label", { task_id: "t1", label_id: "missing" }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // ON DELETE CASCADE still removes the relation with its task
    db.exec("DELETE FROM task WHERE id = 't2'");
    expect(
      db.query("SELECT COUNT(*) AS count FROM task_relations").get(),
    ).toEqual({ count: 0 });
  });
});

test("core rejects values outside each vocabulary before SQL and writes nothing", () => {
  withDirectory((directory) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      import { strict as assert } from "node:assert";
      import { project, task, label, relation } from ${JSON.stringify(new URL("../../index.ts", import.meta.url).pathname)};
      import { getDb } from ${JSON.stringify(new URL("../db.ts", import.meta.url).pathname)};
      const actor = { name: "Test Human", email: null, kind: "human" };
      const app = project.create({ key: "APP" }, actor);
      const first = task.create({ project_id: app.id, title: "First" }, actor);
      const second = task.create({ project_id: app.id, title: "Second" }, actor);
      const rowCount = (table) => getDb().query("SELECT COUNT(*) AS count FROM " + table).get().count;
      const activityBefore = rowCount("activity");

      assert.throws(() => task.create({ project_id: app.id, title: "Bad", priority: "someday" }, actor));
      assert.throws(() => task.edit({ taskKey: first.key, priority: "someday" }, actor));
      assert.throws(() => label.create({ name: "bad", color: "purple" }, actor));
      label.create({ name: "good" }, actor);
      assert.throws(() => label.edit({ labelName: "good", color: "purple" }, actor));
      assert.throws(() => relation.create({ sourceTaskKey: first.key, targetTaskKey: second.key, relation_type: "blocks" }, actor));
      assert.throws(() => project.create({ key: "BAD" }, { ...actor, kind: "robot" }));

      assert.equal(rowCount("task"), 2);
      assert.equal(getDb().query("SELECT COUNT(*) AS count FROM task WHERE priority IS NOT NULL").get().count, 0);
      assert.equal(label.getByName("good").color, "white");
      assert.equal(rowCount("task_relations"), 0);
      assert.equal(rowCount("project"), 1);
      assert.equal(rowCount("activity"), activityBefore + 1);
    `,
      ],
      { env: { ...process.env, ZINN_DIR: directory } },
    );

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
