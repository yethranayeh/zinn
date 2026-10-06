/**
 * Whether this copy of a package is a published release or source code.
 * Packing writes a release stamp into the package and removes it afterwards, so only the packed
 *  package keeps it. A folder without a readable published stamp counts as source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseMode = "source" | "published";

export const RELEASE_STAMP_FILE = "release-stamp.json";
/** The stamp's content in a published package. */
export const PUBLISHED_STAMP = { release: "published" } as const;

export function readReleaseMode(packageDirectory: string): ReleaseMode {
  try {
    const stamp = JSON.parse(readFileSync(join(packageDirectory, RELEASE_STAMP_FILE), "utf8"));
    return stamp?.release === PUBLISHED_STAMP.release ? "published" : "source";
  } catch {
    return "source";
  }
}

/** Core's own release mode, read from the package this file belongs to. */
export function readCoreReleaseMode() {
  return readReleaseMode(fileURLToPath(new URL("..", import.meta.url)));
}
