import { expect, spyOn, test } from "bun:test";
import { backup, RestoreRefusedError, getStorage } from "@zinn-dev/core";

import { restoreCommand } from "./restore-router";

test("restore keeps the general hint for damaged search index internals and rethrows the error", async () => {
  const failure = Object.assign(new Error("vtable constructor failed: task_search"), {
    code: "SQLITE_ERROR",
  });
  const restore = spyOn(backup, "restore").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(restoreCommand.run(["backup.sqlite", "--yes"])).rejects.toThrow(failure);
    expect(stderr.mock.calls).toEqual([
      [
        `The database is unchanged. Backups taken before each restore attempt are kept in ${getStorage().backupDirectory}.`,
      ],
    ]);
  } finally {
    restore.mockRestore();
    stderr.mockRestore();
  }
});

test("a refused damaged backup does not get the damaged live database hint", async () => {
  const failure = new RestoreRefusedError("The backup is damaged, so nothing was restored", {
    cause: Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
  });
  const restore = spyOn(backup, "restore").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(restoreCommand.run(["backup.sqlite", "--yes"])).rejects.toThrow(failure);
    expect(stderr.mock.calls).toEqual([]);
  } finally {
    restore.mockRestore();
    stderr.mockRestore();
  }
});
