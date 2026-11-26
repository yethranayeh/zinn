import { expect, test } from "bun:test";

import { actorDirectoryMigration } from "./actor-directory";
import { MIGRATIONS } from "./registry";
import { createSchema, readSchemaVersion, upgradeSchema } from "./runner";
import { seedBaseline, snapshot, withDatabase } from "./testing";

const previousMigrations = MIGRATIONS.filter(({ version }) => version < actorDirectoryMigration.version);

test("directory migration preserves version 7 rows and adds a nullable directory without backfilling", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    upgradeSchema(db, [...previousMigrations, actorDirectoryMigration]);
    const after = snapshot(db);

    expect(readSchemaVersion(db)).toBe(actorDirectoryMigration.version);
    expect(db.query("PRAGMA table_info(activity)").all().at(-1)).toMatchObject({
      name: "actor_directory", type: "TEXT", notnull: 0,
    });
    expect(db.query("SELECT actor_directory FROM activity").all()).toEqual([{ actor_directory: null }]);
    const preservedRows = Object.fromEntries(Object.entries(after.rows).map(([table, rows]) => [
      table,
      table === "activity" ? rows.map((row) => {
        const { actor_directory, ...previous } = row as Record<string, unknown>;
        return previous;
      }) : rows,
    ]));
    expect(preservedRows).toEqual(before.rows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    withDatabase((fresh) => {
      createSchema(fresh, [...previousMigrations, actorDirectoryMigration]);
      expect(after.schema).toEqual(snapshot(fresh).schema);
    });
  });
});

test("a failed directory migration rolls back its column, version and rows", () => {
  withDatabase((db) => {
    seedBaseline(db);
    upgradeSchema(db, previousMigrations);
    const before = snapshot(db);
    const failingMigration = {
      ...actorDirectoryMigration,
      apply(connection: Parameters<typeof actorDirectoryMigration.apply>[0]) {
        actorDirectoryMigration.apply(connection);
        throw new Error("planned directory failure");
      },
    };
    expect(() => upgradeSchema(db, [...previousMigrations, failingMigration])).toThrow("planned directory failure");
    expect(snapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
