import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json";
import { cliOpenPolicy, reportLegacyRead, reportLockWait } from "./database";
import { setLegacyReadAllowed } from "./lib";

const CLI_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
// The file name core's release reading looks for.
const RELEASE_STAMP_FILE = "release-stamp.json";

test("the CLI opens the database as the cli client of its own release mode, without legacy reads", () => {
  const { onWait, onLegacyRead, ...policy } = cliOpenPolicy();
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

test("the policy allows legacy reads only once --allow-legacy-read was handled", () => {
  const policy = cliOpenPolicy();

  try {
    expect(policy.allowsLegacyRead).toBe(false);
    setLegacyReadAllowed(true);
    expect(policy.allowsLegacyRead).toBe(true);
  } finally {
    setLegacyReadAllowed(false);
  }
});

test("the policy warns on stderr about the unmarked database that opened for reading", () => {
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(cliOpenPolicy().onLegacyRead).toBe(reportLegacyRead);
    reportLegacyRead({ databasePath: "/data/zinn.sqlite", version: 0, latestVersion: 1 });

    expect(stderr.mock.calls).toHaveLength(1);
    expect(stderr.mock.calls[0]![0]).toContain("/data/zinn.sqlite");
    expect(stderr.mock.calls[0]![0]).toContain("no schema version");
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
