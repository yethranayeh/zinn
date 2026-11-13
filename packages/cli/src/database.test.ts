import { expect, spyOn, test } from "bun:test";

import packageJson from "../package.json";
import { getCliOpenPolicy, reportLockWait } from "./database";
import { RELEASE_MODE } from "./release-identity";

test("the CLI opens the database as the cli client of its own release mode", () => {
  const { onWait, ...policy } = getCliOpenPolicy();
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    onWait?.({ databasePath: "/data/zinn.sqlite", budgetMs: 30000 });

    expect(policy).toEqual({
      client: "cli",
      version: packageJson.version,
      executable: process.argv[1] ?? process.execPath,
      release: "source",
    });
    expect(onWait).toBe(reportLockWait);
    expect(stderr.mock.calls).toEqual([
      ["Another process is using the database. Waiting up to 30 seconds for it to finish."],
    ]);
  } finally {
    stderr.mockRestore();
  }
});

test("checked-in CLI identity is source", () => {
  expect(RELEASE_MODE).toBe("source");
});

test("published files come from build output while workspace links stay on source", () => {
  expect(packageJson.publishConfig.directory).toBe("release-dist");
  expect(packageJson.publishConfig.linkDirectory).toBe(false);
  expect(packageJson.files).toContain("index.js");
  expect(packageJson.scripts.prepack).toContain("prepare-release.ts");
  expect(packageJson.scripts).not.toHaveProperty("postpack");
});
