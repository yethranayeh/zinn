import type { DatabaseFacts, LockWait, OpenPolicy } from "@zinn-dev/core";

import { fileURLToPath } from "node:url";
import { readReleaseMode } from "@zinn-dev/core";

import packageJson from "../package.json";
import { isLegacyReadAllowed } from "./lib";

const MS_PER_SECOND = 1000;
/** The CLI's package folder, which holds its release stamp once it is packed. */
const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

/** Says once on stderr that the command waits for another process to finish with the database. */
export function reportLockWait({ budgetMs }: LockWait) {
  console.error(
    `Another process is using the database. Waiting up to ${budgetMs / MS_PER_SECOND} seconds for it to finish.`,
  );
}

export function reportLegacyRead({ databasePath }: DatabaseFacts) {
  console.error(
    `Warning: the database at ${databasePath} has no schema version. Reads are best effort and may fail or omit data.`,
  );
}

/** How the CLI asks core to open the database. */
export function cliOpenPolicy(): OpenPolicy {
  return {
    client: "cli",
    version: packageJson.version,
    // The script the CLI runs from; the runtime itself when there is none.
    executable: process.argv[1] ?? process.execPath,
    release: readReleaseMode(PACKAGE_DIRECTORY),
    // Read when the database opens, after the router has handled `--allow-legacy-read`
    get allowsLegacyRead() {
      return isLegacyReadAllowed();
    },
    onWait: reportLockWait,
    onLegacyRead: reportLegacyRead,
  };
}
