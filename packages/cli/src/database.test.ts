import { expect, spyOn, test } from "bun:test";

import packageJson from "../package.json";
import { cliOpenPolicy, reportLegacyRead, reportLockWait } from "./database";
import { setLegacyReadAllowed } from "./lib";
import { RELEASE_MODE } from "./release-identity";

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
