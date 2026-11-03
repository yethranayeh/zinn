import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CoreError } from "./errors.ts";

/** Resolves a database path through its nearest existing ancestor without creating anything */
export function resolveDatabasePath(databasePath: string) {
  let ancestor = resolve(databasePath);
  const missingSegments: Array<string> = [];

  try {
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
  } catch (cause) {
    throw new CoreError(
      `Cannot resolve the database path ${databasePath}`,
      "storage",
      { entity: "database", databasePath },
      { cause },
    );
  }
}
