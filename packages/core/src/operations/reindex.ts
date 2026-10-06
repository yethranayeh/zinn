import type { LockWait } from "../migrations/upgrade";

import { assertWritable, getDb } from "../db";
import { DB_PATH } from "../constant";
import { classifyDatabase } from "../migrations/classify";
import { reindexSearch } from "../migrations/reindex";

export type ReindexRunInput = {
  /** Called once when another writer holds the database and the reindex starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export const reindex = {
  /** Rebuilds the search index from the tasks and comments. Opens the database like any change does. */
  run: ({ onWait }: ReindexRunInput = {}) => {
    // Checked before getDb, which would create the schema in an empty file.
    const { state } = classifyDatabase(DB_PATH);

    if (state === "absent" || state === "empty") {
      throw new Error(`There is no Zinn database at ${DB_PATH} to reindex`);
    }

    assertWritable();
    return reindexSearch(getDb(), { onWait });
  },
};
