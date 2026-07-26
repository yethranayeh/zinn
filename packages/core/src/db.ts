import { Database } from "bun:sqlite";
import { DB_PATH, DB_TABLE } from "./constant";
import { randomUUIDv7 } from "bun";

export const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL;");
// TODO: https://bun.com/docs/runtime/sqlite#wal-sidecar-file-cleanup macOS does not auto cleanup

const projectTableSetup = db.query(`CREATE TABLE IF NOT EXISTS ${DB_TABLE.project} (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER);`);
projectTableSetup.run();

export function getProjectByKey(key: string) {
  return db.query(`SELECT * FROM ${DB_TABLE.project} WHERE key = $key`).get({ $key: key });
}

// TODO: switch to object param
export function addProject(key: string, name: string) {
  const query = db.query(`INSERT INTO
    ${DB_TABLE.project} (id, key, name, created_at, updated_at)
    VALUES              ($id, $key, $name, $created, $updated);`);
  const time = Date.now();

  return query.run({ $id: randomUUIDv7(), $key: key, $name: name, $created: time, $updated: time });
}

export function deleteProjectByKey(key: string) {
  return db.query(`DELETE FROM ${DB_TABLE.project} WHERE key = $key;`).run({ $key: key });
}
