import { CoreError } from "./errors.js";
import { SqliteError } from "./sqlite/database.js";

/** Identifies the missing search table while retaining SQLite's original cause. */
export function rethrowSearchError(error: unknown): never {
  if (error instanceof SqliteError && error.message === "no such table: task_search") {
    throw new CoreError(error.message, "storage", { reason: "missing_index" }, { cause: error });
  }

  throw error;
}
