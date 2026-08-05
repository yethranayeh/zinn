import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR_ROOT = tmpdir();
const PREFIX = join(TEMP_DIR_ROOT, "zinntest-");
const TEST_DIR = mkdtempSync(PREFIX);
process.env.ZINN_DIR = TEST_DIR;

// ? Dynamic so env is set before `MAIN_DIR` constant is initialized.
const project = await import("./project");

afterAll(() => {
  if (!TEST_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("project.create can establish a project", () => {
  const created = project.create({ key: "WIP", name: "Work In Progress" });

  expect(created).not.toBeNull();
  expect(created?.key).toBe("WIP");
  expect(created?.name).toBe("Work In Progress");
  expect(created?.task_count).toBe(0);
  expect(created?.archived_at).toBeNull();
});
