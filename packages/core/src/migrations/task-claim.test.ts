import { expect, test } from "bun:test";

import { taskClaimMigration } from "./task-claim";
import { MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { count, seedBaseline, snapshot, withDatabase } from "./testing";

const previousMigrations = MIGRATIONS.filter(({ version }) => version < taskClaimMigration.version);
const throughClaim = [...previousMigrations, taskClaimMigration];

test("claim migration adds an empty claim table and keeps every existing row", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    upgradeSchema(db, throughClaim);
    const after = snapshot(db);

    expect(readSchemaVersion(db)).toBe(taskClaimMigration.version);
    const { task_claim: claims, ...preservedRows } = after.rows;
    expect(claims).toEqual([]);
    expect(preservedRows).toEqual(before.rows);
    expect(db.query("SELECT * FROM pragma_foreign_key_list('task_claim')").all()).toMatchObject([
      { table: "task", from: "task_id", to: "id", on_delete: "CASCADE" },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    withDatabase((fresh) => {
      createSchema(fresh, throughClaim);
      expect(after.schema).toEqual(snapshot(fresh).schema);
    });
  });
});

test("a claim row goes with its task", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, throughClaim);
    db.exec(`INSERT INTO task_claim
      (task_id, actor_kind, actor_session_id, claimed_at, renewed_at, worked_at, lease_ms)
      VALUES ('t3', 'agent', 's1', 1, 1, 1, 60000)`);

    db.exec("DELETE FROM task WHERE id = 't3'");
    expect(count(db, "task_claim")).toBe(0);
  });
});

test("a failed claim migration rolls back its table and version", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    const failingMigration = {
      ...taskClaimMigration,
      apply(connection: Parameters<typeof taskClaimMigration.apply>[0]) {
        taskClaimMigration.apply(connection);
        throw new Error("planned claim failure");
      },
    };
    expect(() => upgradeSchema(db, [...previousMigrations, failingMigration])).toThrow("planned claim failure");
    expect(snapshot(db)).toEqual(before);
  });
});
