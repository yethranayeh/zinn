import type { Database } from "../src/sqlite/database.ts";

export type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

/** Raw application definitions excluding SQLite internals and virtual-table storage. */
export function applicationSchema(db: Database): Array<SchemaObject> {
  return db
    .query<SchemaObject>(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
      AND name NOT IN (
        SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'
      )
      AND tbl_name NOT IN (
        SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'
      )
    ORDER BY type, name
  `)
    .all();
}
