import { getDb } from "../db";

// VACUUM INTO reads through SQLite, so the copy includes writes still in the WAL file.
// It fails when the target file already exists.
export function create(path: string) {
  return getDb().query("VACUUM INTO ?").run(path);
}
