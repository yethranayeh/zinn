import type { LockWait } from "../migrations/upgrade.js";

import { assertWritable, getDb } from "../db.js";
import { reindexSearch } from "../migrations/reindex.js";

export type ReindexRunInput = {
  /** Called once when another writer holds the database and the reindex starts waiting. */
  onWait?: (wait: LockWait) => void;
};

export const reindex = {
  /** Rebuilds the search index from the tasks and comments. Opens the database like any change does. */
  run: ({ onWait }: ReindexRunInput = {}) => {
    assertWritable();
    return reindexSearch(getDb(), { onWait });
  },
};
