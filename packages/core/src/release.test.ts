import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReleaseMode } from "./release";

import packageJson from "../package.json";
import { withDirectory } from "./migrations/testing";
import { PUBLISHED_STAMP, readCoreReleaseMode, readReleaseMode, RELEASE_STAMP_FILE } from "./release";

const CORE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

const RELEASE_VERSION = "1.2.0";

/** `version: null` leaves out package.json. */
type Folder = { stamp?: string; isStampFolder?: boolean; version?: string | null };

function writeFolder(directory: string, { stamp, isStampFolder = false, version = RELEASE_VERSION }: Folder) {
  if (version != null) {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "client", version }));
  }

  if (stamp != null) {
    writeFileSync(join(directory, RELEASE_STAMP_FILE), stamp);
  }

  if (isStampFolder) {
    mkdirSync(join(directory, RELEASE_STAMP_FILE));
  }
}

const PUBLISHED = JSON.stringify(PUBLISHED_STAMP);

const cases: Array<{ folder: Folder; expected: ReleaseMode }> = [
  { folder: {}, expected: "source" },
  { folder: { stamp: PUBLISHED }, expected: "published" },
  { folder: { stamp: '{"release":"source"}' }, expected: "source" },
  { folder: { stamp: "published" }, expected: "source" },
  { folder: { stamp: "" }, expected: "source" },
  { folder: { isStampFolder: true }, expected: "source" },
  { folder: { stamp: PUBLISHED, version: "1.3.0-dev" }, expected: "source" },
  { folder: { stamp: PUBLISHED, version: null }, expected: "source" },
];

test.each(cases)("a package folder with $folder is $expected", ({ folder, expected }) => {
  withDirectory((directory) => {
    writeFolder(directory, folder);
    expect(readReleaseMode(directory)).toBe(expected);
  });
});

test("this source folder has no stamp, so core counts as source", () => {
  expect(existsSync(join(CORE_DIRECTORY, RELEASE_STAMP_FILE))).toBe(false);
  expect(readCoreReleaseMode()).toBe("source");
});

test("the published package includes the stamp", () => {
  expect(packageJson.files).toContain(RELEASE_STAMP_FILE);
});
