/**
 * Whether this copy of a package is a published release or source code.
 * Packing writes a release stamp into the package and removes it afterwards, so only the packed
 *  package keeps it. A folder counts as published only with a readable published stamp and a release
 *  version: a failed pack can leave the stamp behind, and a prerelease such as `0.39.0-dev` is source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseMode = "source" | "published";

export const RELEASE_STAMP_FILE = "release-stamp.json";
/** The stamp's content in a published package. */
export const PUBLISHED_STAMP = { release: "published" } as const;

/** Whether a package version is a prerelease, such as `0.39.0-dev`. */
export function isPrerelease(version: string) {
  return version.includes("-");
}

export function readReleaseMode(packageDirectory: string): ReleaseMode {
  try {
    const stamp = JSON.parse(readFileSync(join(packageDirectory, RELEASE_STAMP_FILE), "utf8"));
    const { version } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    const isReleaseVersion = typeof version === "string" && !isPrerelease(version);

    return stamp?.release === PUBLISHED_STAMP.release && isReleaseVersion ? "published" : "source";
  } catch {
    return "source";
  }
}

/** Core's own release mode, read from the package this file belongs to. */
export function readCoreReleaseMode() {
  return readReleaseMode(fileURLToPath(new URL("..", import.meta.url)));
}
