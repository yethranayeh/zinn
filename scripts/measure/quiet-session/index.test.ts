import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "index.ts");

test.skipIf(process.platform !== "darwin")(
  "the real entry runs a dry-run without changing anything",
  () => {
    const root = mkdtempSync(join(tmpdir(), "quiet-session-entry-"));
    try {
      const jobsPath = join(root, "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify([{ name: "hello", command: "echo hello", estimateMinutes: 1 }]),
      );
      const outDir = join(root, "out");
      const statePath = join(root, "state.json");
      const result = Bun.spawnSync({
        cmd: [process.execPath, ENTRY, "--dry-run", "--jobs", jobsPath, "--out", outDir],
        cwd: root,
        env: { ...process.env, HOME: root, QUIET_SESSION_STATE_FILE: statePath },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(join(outDir, "sessions"))).toBe(false);
      expect(result.stdout.toString()).toContain("hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
