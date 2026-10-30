import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openReadConnection(store: string): DatabaseSync {
  const reader = new DatabaseSync(join(store, "data/zinn.sqlite"), { readOnly: true });

  try {
    // Read-only WAL clients need coordination files before entering the write-denying sandbox.
    // https://www.sqlite.org/wal.html#readonly
    reader.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
}
