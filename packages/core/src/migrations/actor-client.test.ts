import { expect, test } from "bun:test";

import { actorClientMigration } from "./actor-client";
import { MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { seedBaseline, snapshot, withDatabase } from "./testing";

const previousMigrations = MIGRATIONS.filter(({ version }) => version < actorClientMigration.version);

test("client migration preserves version 3 rows and adds a nullable client without backfilling", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    upgradeSchema(db);
    const after = snapshot(db);

    expect(readSchemaVersion(db)).toBe(actorClientMigration.version);
    expect(db.query("PRAGMA table_info(activity)").all().at(-1)).toMatchObject({
      name: "actor_client", type: "TEXT", notnull: 0,
    });
    expect(db.query("SELECT actor_client FROM activity").all()).toEqual([{ actor_client: null }]);
    const preservedRows = Object.fromEntries(Object.entries(after.rows).map(([table, rows]) => [
      table,
      table === "activity" ? rows.map((row) => {
        const { actor_client, ...previous } = row as Record<string, unknown>;
        return previous;
      }) : rows,
    ]));
    expect(preservedRows).toEqual(before.rows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    withDatabase((fresh) => {
      createSchema(fresh);
      expect(after.schema).toEqual(snapshot(fresh).schema);
    });
  });
});

test("a failed client migration rolls back its column, version and rows", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    const failingMigration = {
      ...actorClientMigration,
      apply(connection: Parameters<typeof actorClientMigration.apply>[0]) {
        actorClientMigration.apply(connection);
        throw new Error("planned client failure");
      },
    };
    expect(() => upgradeSchema(db, [...previousMigrations, failingMigration])).toThrow("planned client failure");
    expect(snapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
