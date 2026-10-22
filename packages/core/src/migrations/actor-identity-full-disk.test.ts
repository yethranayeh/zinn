import { strict as assert } from "node:assert";
import { test } from "node:test";

import { SqliteError } from "../sqlite/database";
import { actorIdentityMigration } from "./actor-identity";
import { upgradeSchema } from "./runner";
import { count, foreignKeys, seedBaseline, snapshot, withDatabase } from "./testing";

const ACTIVITY_ROW_COUNT = 400;
const ACTIVITY_CHANGES_BYTES = 1_000;
// Enough for the new table and its primary-key index, but not the activity copy.
const REBUILD_HEADROOM_PAGES = 5;

test("a full disk during the activity copy preserves SQLITE_FULL and the original database", () => {
  withDatabase((db) => {
    seedBaseline(db);
    db.query(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < $rowCount
      )
      INSERT INTO activity
        (id, created_at, actor_name, actor_kind, entity_type, entity_id, action, changes)
      SELECT 'full-disk-' || number, number, 'Test Human', 'human', 'task', 't1', 'edit', $changes
      FROM sequence
    `).run({ $rowCount: ACTIVITY_ROW_COUNT, $changes: "x".repeat(ACTIVITY_CHANGES_BYTES) });
    const before = snapshot(db);
    const pageCount = db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
    db.exec(`PRAGMA max_page_count = ${pageCount + REBUILD_HEADROOM_PAGES}`);

    assert.throws(
      () => upgradeSchema(db, [{
        ...actorIdentityMigration,
        apply(connection) {
          try {
            actorIdentityMigration.apply(connection);
          } catch (error) {
            // The table was created, but the copy failed before dropping the original.
            assert.equal(count(connection, "new_activity"), 0);
            assert.equal(count(connection, "activity"), before.rows.activity!.length);
            throw error;
          }
        },
      }]),
      (error) => error instanceof SqliteError && error.code === "SQLITE_FULL",
    );
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.inTransaction, false);
    assert.equal(foreignKeys(db), 1);
  });
});
