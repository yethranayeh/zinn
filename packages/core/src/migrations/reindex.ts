import type { Database } from "../sqlite/database";
import type { Migration } from "./registry";
import type { FreeSpace } from "./space";
import type { LockOptions } from "./upgrade";

import { latestVersion, MIGRATIONS } from "./registry";
import { readSchemaVersion } from "./runner";
import { regenerateSearch } from "./search";
import {
  assertFreeSpace,
  estimateRequiredFree,
  measureSearchRegeneration,
  readFreeSpace,
  requireDatabaseFile,
  spacePathsFor,
} from "./space";
import { withMigrationLock } from "./upgrade";

export type ReindexOptions = LockOptions & {
  migrations?: ReadonlyArray<Migration>;
  /** Reads a filesystem's free space. Tests pass their own, so no test fills the disk. */
  readFreeSpace?: (path: string) => FreeSpace | null;
};

export type ReindexResult = {
  databasePath: string;
  /** The number of tasks in the rebuilt index, archived ones included. */
  taskCount: number;
};

/**
 * Rebuilds the search index of the database behind db from its task and comment records,
 *  in one transaction under the write lock, after a free-space check.
 * Only the index changes, so no backup is saved: a failure rolls back to the old index.
 * The version is read again under the lock, since this build's index layout fits only its latest version.
 */
export function reindexSearch(
  db: Database,
  {
    migrations = MIGRATIONS,
    readFreeSpace: readFree = readFreeSpace,
    ...lock
  }: ReindexOptions = {},
): ReindexResult {
  const databasePath = requireDatabaseFile(db, "reindex");
  const spacePaths = spacePathsFor(databasePath);

  return withMigrationLock(db, databasePath, { ...lock, operation: "reindex" }, () => {
    const version = readSchemaVersion(db);
    const latest = latestVersion(migrations);

    if (version !== latest) {
      throw new Error(
        `The database at ${databasePath} has schema version ${version}, and this build rebuilds the search index only at version ${latest}. It was left unchanged`,
      );
    }

    const required = estimateRequiredFree(measureSearchRegeneration(db), { includeBackup: false });
    assertFreeSpace(spacePaths, required, readFree);

    return { databasePath, taskCount: regenerateSearch(db) };
  });
}
