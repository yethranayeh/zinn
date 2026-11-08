import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeRunDirectory, resolveScratchDirectory } from "./paths.ts";

test("a scratch directory under the runs folder is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-paths-"));
  try {
    const runsDirectory = join(root, "runs");
    const scratch = join(runsDirectory, "t100");
    mkdirSync(join(scratch, "data"), { recursive: true });
    await removeRunDirectory(scratch, runsDirectory);
    expect(resolveScratchDirectory(runsDirectory, "t100")).toBe(
      join(realpathSync(runsDirectory), "t100"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runs folder itself is never removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-paths-"));
  try {
    const runsDirectory = join(root, "runs");
    mkdirSync(runsDirectory, { recursive: true });
    await expect(removeRunDirectory(runsDirectory, runsDirectory)).rejects.toThrow(
      "Refusing to remove",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run directory outside the runs folder is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-paths-"));
  try {
    const runsDirectory = join(root, "runs");
    const outside = join(root, "outside");
    mkdirSync(runsDirectory, { recursive: true });
    mkdirSync(outside, { recursive: true });
    await expect(removeRunDirectory(outside, runsDirectory)).rejects.toThrow("Refusing to remove");
    expect(() => resolveScratchDirectory(runsDirectory, "../outside")).toThrow("outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link inside the runs folder cannot point outside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-paths-"));
  try {
    const runsDirectory = join(root, "runs");
    const outside = join(root, "outside");
    mkdirSync(runsDirectory, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(runsDirectory, "link"));
    expect(() => resolveScratchDirectory(runsDirectory, "link")).toThrow("outside");
    await expect(removeRunDirectory(join(runsDirectory, "link"), runsDirectory)).rejects.toThrow(
      "Refusing to remove",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
