import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecordFolder, recordFolderPath, writeMeta } from "./record.ts";

const START = new Date("2026-11-08T19:41:30");

test("a record folder is named from its local timestamp and label", () => {
  expect(recordFolderPath("/results", "time-0.44.0", START)).toBe(
    "/results/20261108-194130-time-0.44.0",
  );
});

test("an existing record folder is never overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-record-"));
  try {
    const directory = await createRecordFolder(root, "time-0.44.0", START);
    await writeMeta(directory, { first: true });

    await expect(createRecordFolder(root, "time-0.44.0", START)).rejects.toThrow(
      "already exists",
    );
    expect(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"))).toEqual({
      first: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run at another second gets its own folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-record-"));
  try {
    const first = await createRecordFolder(root, "disk-0.44.0", START);
    const second = await createRecordFolder(root, "disk-0.44.0", new Date(START.getTime() + 1_000));
    expect(first).not.toBe(second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
