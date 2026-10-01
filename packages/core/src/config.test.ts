import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.each(["directory", "config"])("config initialization tolerates a concurrent %s creation", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-config-"));
  const store = join(directory, "store");
  const barrier = join(directory, "barrier");
  const configModule = fileURLToPath(new URL("./config.ts", import.meta.url));
  mkdirSync(barrier);
  if (mode === "config") {
    mkdirSync(join(store, "data"), { recursive: true });
  }

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
        let writes = 0;
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
            if (${JSON.stringify(mode)} === "directory" && String(path).startsWith(store)) {
              synchronize();
            }
            return originals.mkdirSync(path, options);
          },
          writeFileSync(path, data, options) {
            if (${JSON.stringify(mode)} === "config" && String(path) === join(store, "settings.json")) {
              synchronize();
            }
            originals.writeFileSync(path, data, options);
            if (String(path) === join(store, "settings.json")) {
              writes++;
            }
          },
        }));
        const { ensureConfigSetup } = await import(${JSON.stringify(configModule)});
        ensureConfigSetup();
        console.log(writes);
      `], { env: { ...process.env, ZINN_DIR: store }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }));

    for (const outcome of outcomes) {
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toBe("");
    }
    expect(outcomes.reduce((writes, outcome) => writes + Number(outcome.stdout), 0)).toBe(1);
    expect(readFileSync(join(store, "settings.json"), "utf8")).toBe("{}\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("config initialization preserves an existing file and reports other filesystem failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-config-"));
  const configModule = fileURLToPath(new URL("./config.ts", import.meta.url));
  const settings = '{"custom":"Größe"}\n';
  writeFileSync(join(directory, "settings.json"), settings);

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { ensureConfigSetup } from ${JSON.stringify(configModule)};
      ensureConfigSetup();
      ensureConfigSetup();
    `], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe(settings);

    const blockedStore = join(directory, "blocked");
    writeFileSync(blockedStore, "a file cannot contain a data directory");
    const blocked = Bun.spawnSync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { ensureConfigSetup } from ${JSON.stringify(configModule)};
      assert.throws(() => ensureConfigSetup(), (error) => error.code === "ENOTDIR" || error.code === "EEXIST");
    `], { env: { ...process.env, ZINN_DIR: blockedStore } });
    expect(blocked.exitCode).toBe(0);
    expect(blocked.stderr.toString()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
