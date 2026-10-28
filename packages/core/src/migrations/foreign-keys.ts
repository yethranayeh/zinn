import type { Database } from "../sqlite/database.js";
import type { ForeignKeyDefinition, Migration } from "./registry.js";

type ForeignKeyRow = {
  id: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
};

type Definitions = Map<string, ReadonlyArray<ForeignKeyDefinition>>;

/**
 * SQLite folds ASCII identifiers only, including names stored in REFERENCES clauses
 * @link https://github.com/sqlite/sqlite/blob/master/src/global.c
 */
function foldIdentifier(name: string) {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function readDefinitions(db: Database): Definitions {
  const tables = db
    .query<{ name: string }>(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all();
  const definitions: Definitions = new Map();

  for (const { name } of tables) {
    const rows = db
      .query<ForeignKeyRow>(`
      SELECT id, [table], [from], [to], on_update, on_delete
      FROM pragma_foreign_key_list($table, 'main') ORDER BY id, seq
    `)
      .all({ $table: name });
    const keys = new Map<number, ForeignKeyDefinition>();
    const columns = new Map<number, Array<{ from: string; to: string | null }>>();

    for (const row of rows) {
      let pairs = columns.get(row.id);
      if (pairs === undefined) {
        pairs = [];
        columns.set(row.id, pairs);
        keys.set(row.id, {
          table: row.table,
          columns: pairs,
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        });
      }
      pairs.push({ from: row.from, to: row.to });
    }

    definitions.set(foldIdentifier(name), [...keys.values()]);
  }

  return definitions;
}

function canonicalDefinitions(definitions: ReadonlyArray<ForeignKeyDefinition>) {
  return definitions
    .map((definition) =>
      JSON.stringify({
        table: foldIdentifier(definition.table),
        columns: definition.columns.map(({ from, to }) => ({
          from: foldIdentifier(from),
          to: to === null ? null : foldIdentifier(to),
        })),
        onUpdate: definition.onUpdate.toUpperCase(),
        onDelete: definition.onDelete.toUpperCase(),
      }),
    )
    .sort();
}

function assertDefinitions(
  migration: Migration,
  table: string,
  expected: ReadonlyArray<ForeignKeyDefinition>,
  actual: ReadonlyArray<ForeignKeyDefinition>,
  phase: "before" | "after",
) {
  const expectedKeys = canonicalDefinitions(expected);
  const actualKeys = canonicalDefinitions(actual);

  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error(
      `Migration ${migration.version} (${migration.name}) has unexpected foreign keys in ${table} ${phase} applying the step: expected [${expectedKeys.join(", ")}], found [${actualKeys.join(", ")}]`,
    );
  }
}

/** Checks declared starting definitions and prepares complete expectations for the step */
export function prepareForeignKeyVerification(db: Database, migration: Migration) {
  const expected = readDefinitions(db);
  const declaredTables = new Set<string>();

  for (const [table, change] of Object.entries(migration.foreignKeyChanges ?? {})) {
    const name = foldIdentifier(table);
    if (declaredTables.has(name)) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) declares foreign key changes twice for ${table}`,
      );
    }
    declaredTables.add(name);
    assertDefinitions(migration, table, change.before, expected.get(name) ?? [], "before");
    expected.set(name, change.after);
  }

  return expected;
}

/** Parent renames can change child tables outside the migration's rebuild list */
export function verifyForeignKeyDefinitions(
  db: Database,
  migration: Migration,
  expected: Definitions,
) {
  const actual = readDefinitions(db);
  for (const [table, definitions] of expected) {
    assertDefinitions(migration, table, definitions, actual.get(table) ?? [], "after");
  }
}
