import { expect, setSystemTime, test } from "bun:test";
import { basename, join } from "node:path";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";

import { openDatabase } from "#sqlite";

import * as dbBackup from "./db/backup";
import { createOutputFileName, readOutputFileName } from "./output-file-name";
import { resolveDatabasePath } from "./database-path";
import { withDirectory } from "./migrations/testing";

const NAME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-.+-[0-9a-f]{8}\.log$/;

test("a name holds the current UTC time to the second, the client, the version and the extension", () => {
  setSystemTime(new Date("2026-09-29T12:30:05.678Z"));

  try {
    const name = createOutputFileName({ client: "cli", version: "0.32.0" }, ".log");

    expect(name.startsWith("2026-09-29T12-30-05Z-cli-0.32.0-")).toBe(true);
    expect(name).toMatch(NAME_SHAPE);
    expect(name).not.toContain("/");
    expect(name).not.toContain(":");
  } finally {
    setSystemTime();
  }
});

test("two names made in the same second differ", () => {
  setSystemTime(new Date("2026-09-29T12:30:05Z"));

  try {
    const input = { client: "cli", version: "0.32.0" };
    const names = Array.from({ length: 20 }, () => createOutputFileName(input, ".log"));

    expect(new Set(names).size).toBe(names.length);
  } finally {
    setSystemTime();
  }
});

test.each([
  { client: "cli", version: "0.32.0" },
  { client: "cli", version: "0.44.0-dev" },
  { client: "zinn-tui", version: "1.0.0-beta.2" },
  { client: "zinn-tui", version: "0.44.0-dev" },
])("$client $version round trips", (input) => {
  for (const extension of [".log", ".sqlite"]) {
    expect(readOutputFileName(createOutputFileName(input, extension), extension)).toEqual(input);
  }
});

test("reading takes a path and uses its base name", () => {
  const name = createOutputFileName({ client: "cli", version: "0.44.0-dev" }, ".log");

  expect(readOutputFileName(join("/store", "logs", name), ".log")).toEqual({
    client: "cli",
    version: "0.44.0-dev",
  });
  expect(readOutputFileName(join(name, "notes.log"), ".log")).toBeNull();
});

test("another extension, or a longer one, is not the file that was asked for", () => {
  const log = createOutputFileName({ client: "cli", version: "1.2.3" }, ".log");

  expect(readOutputFileName(log, ".sqlite")).toBeNull();
  expect(readOutputFileName(`${log}.partial`, ".log")).toBeNull();
  expect(readOutputFileName(`${log}.sqlite`, ".sqlite")).toBeNull();
  // The dot is literal, so "xlog" does not pass for ".log".
  expect(readOutputFileName(log.replace(".log", "xlog"), ".log")).toBeNull();
});

test.each([
  "notes.log",
  ".log",
  "2026-10-06T12-30-05Z-cli-1a2b3c4d.log",
  "2026-10-06T12-30-05Z-test-unknown-1a2b3c4d.log",
  "2026-10-06T12-30-05Z-cli-1.2.3-XYZ.log",
  "2026-10-06T12-30-05Z-cli-1.2.3-1A2B3C4D.log",
  "2026-10-06T12-30-05-cli-1.2.3-1a2b3c4d.log",
  "2026-10-06T12:30:05Z-cli-1.2.3-1a2b3c4d.log",
  "prefix-2026-10-06T12-30-05Z-cli-1.2.3-1a2b3c4d.log",
])("%s is not a name the builder makes", (name) => {
  expect(readOutputFileName(name, ".log")).toBeNull();
});

test("a backup keeps its name pattern and reads back, and its partial name does not", () => {
  withDirectory((directory) => {
    const databasePath = join(realpathSync(directory), "zinn.sqlite");
    const db = openDatabase(databasePath);
    db.exec("CREATE TABLE item (value INTEGER)");
    db.close();
    const backups = join(directory, "backups");
    mkdirSync(backups);

    for (const input of [
      { client: "cli", version: "0.32.0" },
      { client: "zinn-tui", version: "0.44.0-dev" },
    ]) {
      const { path } = dbBackup.create(resolveDatabasePath(databasePath), backups, input);
      const name = basename(path);

      expect(name).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z-${input.client}-${input.version}-[0-9a-f]{8}\\.sqlite$`,
        ),
      );
      expect(dbBackup.readBackupFileName(path)).toEqual(input);
      expect(dbBackup.readBackupFileName(`${path}.partial`)).toBeNull();
      expect(readOutputFileName(path, ".sqlite")).toEqual(input);
    }

    expect(readdirSync(backups).filter((entry) => entry.endsWith(".partial"))).toEqual([]);
  });
});
