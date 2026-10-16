import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";

import { expect, test } from "bun:test";

import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { actorIdentityMigration } from "./actor-identity";
import { count, seedBaseline, snapshot, withDatabase } from "./testing";

const EXISTING_ACTIVITY_COLUMNS = [
  "id",
  "created_at",
  "actor_name",
  "actor_email",
  "actor_kind",
  "entity_type",
  "entity_id",
  "action",
  "changes",
] as const;

type ExistingActivityColumn = (typeof EXISTING_ACTIVITY_COLUMNS)[number];

function activityColumnInfo(db: Database) {
  return db.query<{ name: string; type: string; notnull: number; pk: number }>("PRAGMA table_info(activity)").all();
}

function existingActivityRows(db: Database) {
  const columns = EXISTING_ACTIVITY_COLUMNS.join(", ");
  return db.query(`SELECT ${columns} FROM activity ORDER BY id`).all() as Array<
    Record<ExistingActivityColumn, unknown>
  >;
}

function seedActivityRows(db: Database) {
  seedBaseline(db);
  db.exec(`
    INSERT INTO activity
      (id, created_at, actor_name, actor_email, actor_kind, entity_type, entity_id, action, changes)
    VALUES
      ('activity-agent', 11, '1', NULL, 'agent', 'task', 't1', 'edit', '{"title":["old","new"]}'),
      ('activity-human-email', 12, 'Human With Email', 'human@example.test', 'human', 'project', 'p1', 'edit', NULL),
      ('activity-human-no-email', 13, 'Human Without Email', NULL, 'human', 'column', 'c1', 'edit', '{"name":["Todo","Next"]}'),
      ('activity-label', 14, 'Label Actor', NULL, 'agent', 'label', 'l1', 'delete', NULL);
  `);
}

function expectedActivityColumns(db: Database) {
  return activityColumnInfo(db).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
}

function nonActivitySnapshot(db: Database) {
  const databaseSnapshot = snapshot(db);
  const nonActivityRows = Object.fromEntries(
    Object.entries(databaseSnapshot.rows).filter(([table]) => table !== "activity"),
  );
  const nonActivitySchema = databaseSnapshot.schema.filter(
    ({ name, tbl_name }) => name !== "activity" && tbl_name !== "activity",
  );

  return { schema: nonActivitySchema, rows: nonActivityRows };
}

test("version 2 preserves every version 1 activity value and adds nullable identity fields", () => {
  withDatabase((db) => {
    seedActivityRows(db);
    db.exec("PRAGMA user_version = 1");
    const before = existingActivityRows(db);
    const nonActivityBefore = nonActivitySnapshot(db);
    const countBefore = count(db, "activity");

    upgradeSchema(db);

    expect(readSchemaVersion(db)).toBe(2);
    expect(count(db, "activity")).toBe(countBefore);
    expect(existingActivityRows(db)).toEqual(before);
    expect(nonActivitySnapshot(db)).toEqual(nonActivityBefore);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      db
        .query<Record<string, string | null>>("SELECT actor_source, actor_session_id, actor_thread_id, actor_agent, actor_model, actor_effort FROM activity")
        .all()
        .every((row) => Object.values(row).every((value) => value === null)),
    ).toBe(true);

    const nameColumn = activityColumnInfo(db).find(({ name }) => name === "actor_name");
    expect(nameColumn?.notnull).toBe(0);
  });
});

test("a version 2 upgrade has the same activity columns as a fresh schema", () => {
  let upgradedColumns: Array<unknown> = [];
  let freshColumns: Array<unknown> = [];

  withDatabase((db) => {
    seedActivityRows(db);
    db.exec("PRAGMA user_version = 1");
    upgradeSchema(db);
    upgradedColumns = expectedActivityColumns(db);
  });

  withDatabase((db) => {
    createSchema(db);
    freshColumns = expectedActivityColumns(db);
  });

  expect(upgradedColumns).toEqual(freshColumns);
});

test("a failed version 2 migration rolls back its schema, rows and version", () => {
  withDatabase((db) => {
    seedActivityRows(db);
    db.exec("PRAGMA user_version = 1");
    const before = snapshot(db);
    const failingMigration: Migration = {
      ...actorIdentityMigration,
      apply(connection) {
        actorIdentityMigration.apply(connection);
        throw new Error("planned migration failure");
      },
    };

    expect(() => upgradeSchema(db, [failingMigration])).toThrow("planned migration failure");
    expect(snapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() =>
      db.exec("INSERT INTO task_label (task_id, label_id) VALUES ('missing-task', 'missing-label')"),
    ).toThrow();
  });
});

test("the rebuilt activity table accepts a null actor name", () => {
  withDatabase((db) => {
    createSchema(db);

    db.query(`
      INSERT INTO activity
        (id, created_at, actor_name, actor_email, actor_kind, entity_type, entity_id, action)
      VALUES ('unnamed-agent', 20, NULL, NULL, 'agent', 'task', 't1', 'edit')
    `).run();

    expect(db.query("SELECT actor_name, actor_kind FROM activity WHERE id = 'unnamed-agent'").get()).toEqual({
      actor_name: null,
      actor_kind: "agent",
    });
  });
});
