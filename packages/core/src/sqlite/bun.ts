import type { OpenOptions, SqliteDriver } from "./database.ts";
import { Database as BunDatabase } from "bun:sqlite";

import { openWith, opensExistingOnly } from "./database.ts";

function openFlags(options: OpenOptions) {
  if (options.readonly) {
    return { readonly: true };
  }

  // readwrite alone is `SQLITE_OPEN_READWRITE` without `SQLITE_OPEN_CREATE`, so a missing file is not created.
  return opensExistingOnly(options) ? { readwrite: true } : { create: true };
}

export const driver: SqliteDriver = {
  connect(path, options) {
    const db = new BunDatabase(path, { ...openFlags(options), safeIntegers: true });

    return {
      /**
       * `query()` instead of `prepare()` because bun:sqlite finalizes the statements
       *  that `query()` caches when the connection closes,
       *  so `close()` releases the database file instead of waiting for GC.
       */
      prepare: (sql) => db.query(sql),
      exec: (sql) => {
        db.run(sql);
      },
      get inTransaction() {
        return db.inTransaction;
      },
      close: () => db.close(),
    };
  },
  // bun:sqlite names its errors "SQLiteError" and gives the extended result code as errno.
  resultCode(error) {
    const isSqliteError = error instanceof Error && error.name === "SQLiteError";

    if (isSqliteError && "errno" in error && typeof error.errno === "number") {
      return error.errno;
    }

    return null;
  },
};

export function openDatabase(path: string, options?: OpenOptions) {
  return openWith(driver, path, options);
}
