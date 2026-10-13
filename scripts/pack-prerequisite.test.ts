import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("packing checks fail clearly when pnpm is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-pack-prerequisite-"));

  try {
    const script = fileURLToPath(new URL("pack.test.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, "test", script], {
      env: { ...process.env, PATH: directory },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("pnpm is required");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
