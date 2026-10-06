import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReleaseMode } from "./release";

import packageJson from "../package.json";
import { withDirectory } from "./migrations/testing";
import { PUBLISHED_STAMP, readCoreReleaseMode, readReleaseMode, RELEASE_STAMP_FILE } from "./release";

const CORE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

type Folder = { stamp?: string; isStampFolder?: boolean };

function writeFolder(directory: string, { stamp, isStampFolder = false }: Folder) {
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
