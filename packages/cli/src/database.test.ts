import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json";
import { cliOpenPolicy, reportLockWait } from "./database";

const CLI_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
// The file name core's release reading looks for.
const RELEASE_STAMP_FILE = "release-stamp.json";

test("the CLI opens the database as the cli client of its own release mode, without legacy reads", () => {
  const { onWait, ...policy } = cliOpenPolicy();
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    onWait?.({ databasePath: "/data/zinn.sqlite", budgetMs: 30000 });

    expect(policy).toEqual({
      client: "cli",
      version: packageJson.version,
      executable: process.argv[1] ?? process.execPath,
      release: "source",
      allowsLegacyRead: false,
    });
    expect(onWait).toBe(reportLockWait);
    expect(stderr.mock.calls).toEqual([
      ["Another process is using the database. Waiting up to 30 seconds for it to finish."],
    ]);
  } finally {
    stderr.mockRestore();
  }
});

test("this source folder has no stamp", () => {
  expect(existsSync(join(CLI_DIRECTORY, RELEASE_STAMP_FILE))).toBe(false);
});

test("the published package includes the stamp", () => {
  expect(packageJson.files).toContain(RELEASE_STAMP_FILE);
});
