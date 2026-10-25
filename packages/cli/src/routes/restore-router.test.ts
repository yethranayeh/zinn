import { expect, spyOn, test } from "bun:test";
import { backup, RestoreRefusedError, getStorage, SqliteError } from "@zinn-dev/core";

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
  const failure = new RestoreRefusedError("The backup is damaged, so nothing was restored", "storage", {}, {
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

test.each([11, 779, (100 << 8) | 11])("restore gives recovery guidance for corruption code %s", async (errcode) => {
  const failure = new SqliteError("damaged database", errcode, null);
  const restore = spyOn(backup, "restore").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(restoreCommand.run(["backup.sqlite", "--yes"])).rejects.toBe(failure);
    expect(stderr.mock.calls).toHaveLength(1);
    const diagnostic = stderr.mock.calls.flat().join("\n");
    const { databasePath } = getStorage();
    for (const fact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, "zinn restore"]) {
      expect(diagnostic).toContain(fact);
    }
  } finally {
    restore.mockRestore();
    stderr.mockRestore();
  }
});

test.each([
  new SqliteError("not a database", 26, null),
  new SqliteError("search index failure", 1, null),
  Object.assign(new Error("shaped corruption error"), { code: "SQLITE_CORRUPT", errcode: 11 }),
  new Error("wrapped corruption", { cause: new SqliteError("damaged database", 11, null) }),
])("restore keeps the general hint for %s", async (failure) => {
  const restore = spyOn(backup, "restore").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(restoreCommand.run(["backup.sqlite", "--yes"])).rejects.toBe(failure);
    expect(stderr.mock.calls).toHaveLength(1);
    const diagnostic = stderr.mock.calls.flat().join("\n");
    expect(diagnostic).toContain(getStorage().backupDirectory);
    expect(diagnostic).not.toContain("-wal");
    expect(diagnostic).not.toContain("zinn restore");
  } finally {
    restore.mockRestore();
    stderr.mockRestore();
  }
});

test("a refused backup with a normalized corruption cause gets no live recovery hint", async () => {
  const failure = new RestoreRefusedError("damaged backup", "storage", {}, {
    cause: new SqliteError("damaged database", 11, null),
  });
  const restore = spyOn(backup, "restore").mockImplementation(() => {
    throw failure;
  });
  const stderr = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(restoreCommand.run(["backup.sqlite", "--yes"])).rejects.toBe(failure);
    expect(stderr.mock.calls).toEqual([]);
  } finally {
    restore.mockRestore();
    stderr.mockRestore();
  }
});
