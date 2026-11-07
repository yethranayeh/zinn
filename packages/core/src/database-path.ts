import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CoreError } from "./errors.ts";

declare const resolvedPathBrand: unique symbol;

/** A path resolved through its nearest existing ancestor. Functions that take one use it as given and never resolve it again. */
export type ResolvedPath = string & { readonly [resolvedPathBrand]: true };

/** Resolves a path through its nearest existing ancestor without creating anything */
function resolveThroughAncestor(path: string) {
  let ancestor = resolve(path);
  const missingSegments: Array<string> = [];

  // `lstat` distinguishes a missing entry from an existing link whose target is missing
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }

    missingSegments.unshift(basename(ancestor));
    ancestor = parent;
  }

  return join(realpathSync(ancestor), ...missingSegments);
}

/** Resolves a database path through its nearest existing ancestor without creating anything */
export function resolveDatabasePath(databasePath: string): ResolvedPath {
  try {
    return resolveThroughAncestor(databasePath) as ResolvedPath;
  } catch (cause) {
    throw new CoreError(
      `Cannot resolve the database path ${databasePath}`,
      "storage",
      { entity: "database", databasePath },
      { cause },
    );
  }
}

/** Resolves a backup folder through its nearest existing ancestor without creating anything */
export function resolveBackupDirectory(backupDirectory: string): ResolvedPath {
  try {
    return resolveThroughAncestor(backupDirectory) as ResolvedPath;
  } catch (cause) {
    throw new CoreError(
      `Cannot resolve the backup folder ${backupDirectory}`,
      "storage",
      { entity: "backup", backupDirectory },
      { cause },
    );
  }
}
