import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "./package.json";
import { generateCapabilities } from "./src/capabilities";
import { checkCapabilityDiscovery, inventory } from "./capability-checks";
import { runCli } from "./testing";

const root = mkdtempSync(join(tmpdir(), "zinn-discovery-guard-"));
const guard = fileURLToPath(new URL("./discovery-guard.mjs", import.meta.url));
const node = Bun.which("node");
if (node === null) {
  throw new Error("Node is required to check discovery isolation on both runtimes.");
}
const runtimes = [{ name: "Bun", path: process.execPath }, { name: "Node", path: node }];
const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
const timeoutMs = 5000;
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const runtime of runtimes) {
  test(`${runtime.name} discovery check rejects an injected named settings read`, () => {
    const directory = join(root, runtime.name);
    const fixture = join(directory, "package");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify(packageJson));
    const entryPoint = join(fixture, "index.mjs");
    writeFileSync(entryPoint, `
      import { readFileSync } from "node:fs";
      readFileSync(new URL("../zinn.local.json", import.meta.url), "utf8");
      console.log(${JSON.stringify(JSON.stringify(generateCapabilities()))});
    `);
    expect(() => checkCapabilityDiscovery({
      runtime: runtime.path, entryPoint, packageDirectory: fixture,
      directory, env, timeoutMs,
    })).toThrow("Forbidden discovery access");
  });

  test(`${runtime.name} guard blocks SQLite, named reads, writes outside the store and child processes`, () => {
    const directory = join(root, `${runtime.name}-apis`);
    const outsideStore = join(directory, "outside-store");
    mkdirSync(outsideStore, { recursive: true });
    const source = join(outsideStore, "source.txt");
    const destination = join(outsideStore, "destination.txt");
    writeFileSync(source, "unchanged");
    const settings = join(outsideStore, "settings.json");
    writeFileSync(settings, "{}");
    const fixture = join(directory, "fixture.mjs");
    const operations = [
      `import { existsSync } from "fs"; existsSync(${JSON.stringify(settings)});`,
      `import { readFile } from "node:fs/promises"; await readFile(${JSON.stringify(settings)});`,
      `import { DatabaseSync } from "node:sqlite"; new DatabaseSync(":memory:");`,
      ...["copyFileSync", "cpSync", "symlinkSync"].map((name) =>
        `import { ${name} } from "node:fs"; ${name}(${JSON.stringify(source)}, ${JSON.stringify(destination)});`),
      `import { mkdtempSync } from "node:fs"; mkdtempSync(${JSON.stringify(destination)});`,
      `import { truncateSync } from "node:fs"; truncateSync(${JSON.stringify(source)}, 0);`,
      ...["w", "r+", 2].map((flag) =>
        `import { openSync } from "node:fs"; openSync(${JSON.stringify(source)}, ${JSON.stringify(flag)});`),
      `import { open } from "node:fs"; open(${JSON.stringify(source)}, "w", () => {});`,
      `import { open } from "fs/promises"; await open(${JSON.stringify(source)}, "a");`,
      `import { copyFile } from "node:fs/promises"; await copyFile(${JSON.stringify(source)}, ${JSON.stringify(destination)});`,
      `import { spawnSync } from "node:child_process"; spawnSync(process.execPath, ["--version"]);`,
      `import { readFileSync } from "node:fs"; readFileSync(${JSON.stringify(source)}, { flag: "w" });`,
    ];
    if (runtime.name === "Bun") {
      operations.push(`import { Database } from "bun:sqlite"; new Database(":memory:");`);
    }
    const before = inventory(outsideStore);
    for (const operation of operations) {
      writeFileSync(fixture, operation);
      const result = runCli([fixture], {
        runtime: runtime.path, cliPath: guard, cwd: directory,
        env: { ...env, ZINN_DIR: join(directory, "store") }, timeoutMs,
      });
      expect(result.code, operation).not.toBe(0);
      expect(result.stderr, operation).toContain("Forbidden discovery access");
      expect(result.stdout).toBe("");
    }
    expect(inventory(outsideStore)).toEqual(before);
  });
}
