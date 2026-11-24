import { expect, spyOn, test } from "bun:test";
import { migrate, getBackupStorage } from "@zinn-dev/core";

import { migrateCommand } from "./migrate-router";

test("a failure before saving a snapshot reports the database was unchanged and rethrows the error", () => {
  const failure = new Error("migration broke");
  const run = spyOn(migrate, "run").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => migrateCommand.run([])).toThrow(failure);
    expect(stderr.mock.calls).toHaveLength(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("unchanged");
    expect(stderr.mock.calls[0]?.[0]).not.toContain(getBackupStorage().backupDirectory);
  } finally {
    run.mockRestore();
    stderr.mockRestore();
  }
});

test("the backup folder is inside the isolated test directory", () => {
  expect(getBackupStorage().backupDirectory.startsWith(process.env.ZINN_DIR!)).toBe(true);
});
