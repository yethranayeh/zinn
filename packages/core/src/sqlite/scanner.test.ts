/**
 * Oracle check for the placeholder scanner, Bun only.
 * For each SQL string, the wrapper must either refuse it or count the same parameters as SQLite.
 */
import { Database as BunDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";

import { scanPlaceholders } from "./database.ts";

const SQL_SAMPLES = [
  "SELECT ?",
  "SELECT ?, ?, ?",
  "SELECT $a, $a, $b",
  "SELECT '?' || '$a'",
  "SELECT 'it''s ?'",
  "SELECT 'a' || ? -- ? $x",
  "SELECT /* ? $x */ ?",
  "SELECT 1 AS `?`, ?",
  "SELECT 1 AS [$a ?], $b",
  "SELECT $a1_B2",
  "SELECT ($a)+$b",
  "SELECT $a$b",
  "SELECT $naïve",
  "SELECT $é",
  "SELECT $a::b",
  "SELECT $::a",
  "SELECT $a(x)",
  "SELECT $a(",
  "SELECT $$",
  "SELECT $",
  "SELECT 1 AS x$y, ?",
  "SELECT 1 AS é$a, ?",
  'SELECT "a"',
  "SELECT '\"a\"', ?",
  "SELECT :a",
  "SELECT @a",
  "SELECT ?1",
  "SELECT $a -- \"x\"\n, ?",
];

test.each(SQL_SAMPLES)("scanner agrees with SQLite or refuses: %s", (sql) => {
  let scannedCount: number;
  try {
    const placeholders = scanPlaceholders(sql);
    scannedCount = placeholders.names.size + placeholders.positionalCount;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return;
  }

  const db = new BunDatabase(":memory:");
  try {
    let sqliteCount: number;
    try {
      // SQLite's distinct-parameter count is paramsCount: a repeated $a counts once.
      sqliteCount = db.prepare(sql).paramsCount;
    } catch {
      // SQLite itself refuses this SQL, so the scanner's count is never used.
      return;
    }

    expect(scannedCount).toBe(sqliteCount);
  } finally {
    db.close();
  }
});
