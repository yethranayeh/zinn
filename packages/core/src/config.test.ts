import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("data directory creation tolerates concurrent callers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-config-"));
  const store = join(directory, "store");
  const barrier = join(directory, "barrier");
  const configModule = fileURLToPath(new URL("./config.ts", import.meta.url));
  mkdirSync(barrier);

  try {
    const outcomes = await Promise.all([0, 1].map(async (worker) => {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { mock } from "bun:test";
        import * as fs from "node:fs";
        import { join } from "node:path";
        const originals = { ...fs };
        const store = process.env.ZINN_DIR;
        const barrier = ${JSON.stringify(barrier)};
        let synchronized = false;
        function synchronize() {
          if (synchronized) {
            return;
          }
          synchronized = true;
          originals.writeFileSync(join(barrier, ${JSON.stringify(String(worker))}), "ready");
          const began = performance.now();
          while (originals.readdirSync(barrier).length < 2) {
            if (performance.now() - began > 5_000) {
              throw new Error("Concurrent config barrier timed out");
            }
            Bun.sleepSync(1);
          }
        }
        mock.module("node:fs", () => ({
          ...originals,
          mkdirSync(path, options) {
            if (String(path).startsWith(store)) {
              synchronize();
            }
            return originals.mkdirSync(path, options);
          },
        }));
        const { ensureDataDirectory } = await import(${JSON.stringify(configModule)});
        ensureDataDirectory();
      `], { env: { ...process.env, ZINN_DIR: store }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    }));

    for (const outcome of outcomes) {
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toBe("");
    }
    expect(statSync(join(store, "data")).isDirectory()).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("data directory creation leaves an existing directory and its contents alone and reports other filesystem failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-config-"));
  const configModule = fileURLToPath(new URL("./config.ts", import.meta.url));
  const content = "existing data\n";
  mkdirSync(join(directory, "data"));
  writeFileSync(join(directory, "data", "existing.txt"), content);

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { ensureDataDirectory } from ${JSON.stringify(configModule)};
      ensureDataDirectory();
      ensureDataDirectory();
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(readFileSync(join(directory, "data", "existing.txt"), "utf8")).toBe(content);
    expect(existsSync(join(directory, "settings.json"))).toBe(false);

    const blockedStore = join(directory, "blocked");
    writeFileSync(blockedStore, "a file cannot contain a data directory");
    const blocked = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { ensureDataDirectory } from ${JSON.stringify(configModule)};
      assert.throws(() => ensureDataDirectory(), (error) => error.code === "ENOTDIR" || error.code === "EEXIST");
    `], { env: { ...process.env, ZINN_DIR: blockedStore } });
    expect(blocked.exitCode).toBe(0);
    expect(blocked.stderr.toString()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
