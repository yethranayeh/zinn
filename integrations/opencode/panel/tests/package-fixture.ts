import { strict as assert } from "node:assert";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { listWorkingTreeFiles } from "../../../../scripts/package-fixture.ts";
import { TEST_ENVIRONMENT } from "../../../../scripts/test-isolation.ts";

const repository = resolve(import.meta.dir, "../../../..");
const integration = "integrations/opencode/panel/";
export const hostVersion = "2.2.0";

export function run(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(args, { cwd, env, timeout: 120_000 });
  assert.equal(result.exitCode, 0, `${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Packs current working-tree source without workspace links or ignored files. */
export function packInspector(updated = false) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-opencode-package-"));
  const stage = join(directory, "stage");
  mkdirSync(stage);
  const env: Record<string, string | undefined> = {
    ...TEST_ENVIRONMENT,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    ZINN_DIR: join(directory, "store"),
  };
  for (const [key, value] of Object.entries(env)) {
    if (key === "HOME" || key.startsWith("XDG_") || key === "ZINN_DIR") {
      mkdirSync(value!, { recursive: true });
    }
  }
  for (const path of listWorkingTreeFiles(repository).filter((path) => path.startsWith(integration))) {
    const relative = path.slice(integration.length);
    if (relative.startsWith("node_modules/")) {
      continue;
    }
    const destination = join(stage, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repository, path), destination);
  }
  writeFileSync(join(stage, "NOTES.md"), "Private fixture material\n");
  writeFileSync(join(stage, "pkg/development.test.ts"), "throw new Error('test fixture');\n");
  const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  if (updated) {
    manifest.version += "-update-fixture";
    writeFileSync(join(stage, "package.json"), JSON.stringify(manifest));
    const entry = join(stage, "pkg/tui.tsx");
    writeFileSync(entry, readFileSync(entry, "utf8").replace('"plugin options"', '"updated inspector artifact"'));
  }
  run(["pnpm", "pack", "--pack-destination", directory], stage, env);
  const archive = join(directory, `zinn-dev-opencode-${manifest.version}.tgz`);
  const members = run(["tar", "-tzf", archive], stage, env).trim().split("\n").sort();
  const expected = ["package/package.json", "package/README.md", "package/LICENSE", ...manifest.files.map((path: string) => `package/${path}`)].sort();
  assert.deepEqual(members, expected, "Package members differ from the source allowlist");
  const extracted = join(directory, "extracted");
  mkdirSync(extracted);
  run(["tar", "-xzf", archive, "-C", extracted], stage, env);
  return { directory, env, archive, members, extracted: join(extracted, "package"), manifest };
}

export function installConsumer(fixture: ReturnType<typeof packInspector>) {
  const consumer = join(fixture.directory, "consumer");
  mkdirSync(consumer);
  const hostPackage = `@opencode/cli-${process.platform}-${process.arch}`;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "inspector-package-consumer", private: true, type: "module",
    dependencies: { "@zinn-dev/opencode": `file:${fixture.archive}`, "@zinn-dev/cli": "0.41.0", [hostPackage]: hostVersion },
  }));
  run([process.execPath, "install"], consumer, fixture.env);
  const installed = join(consumer, "node_modules/@zinn-dev/opencode");
  const host = join(consumer, "node_modules", hostPackage, "bin/opencode");
  const releasedCLI = join(consumer, "node_modules/@zinn-dev/cli/index.js");
  const bin = join(fixture.directory, "bin");
  mkdirSync(bin);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const useCLI = (path: string) => {
    const wrapper = join(bin, "zinn");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path)} "$@"\n`);
    chmodSync(wrapper, 0o755);
  };
  useCLI(releasedCLI);
  return { consumer, installed, host, releasedCLI, useCLI, env: { ...fixture.env, PATH: `${bin}:${fixture.env.PATH}` } };
}
