import { expect, spyOn, test } from "bun:test";
import { migrate, getStorage } from "@zinn-dev/core";

import { migrateCommand } from "./migrate-router";

// ? The shipped migration list is empty, so the CLI cannot reach an older database yet.
// ? Making the core call fail stands in for any failure of an upgrade, since the line
// ? on stderr does not depend on the stage that failed.
test("a failed upgrade names the backup folder on stderr and rethrows the original error", () => {
  const failure = new Error("migration broke");
  const run = spyOn(migrate, "run").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => migrateCommand.run([])).toThrow(failure);
    expect(stderr.mock.calls).toEqual([
      [
        `The database is unchanged. Backups taken before each upgrade attempt are kept in ${getStorage().backupDirectory}.`,
      ],
    ]);
  } finally {
    run.mockRestore();
    stderr.mockRestore();
  }
});

test("the backup folder is inside the isolated test directory", () => {
  expect(getStorage().backupDirectory.startsWith(process.env.ZINN_DIR!)).toBe(true);
});
