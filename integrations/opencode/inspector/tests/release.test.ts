import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import manifest from "../package.json";
import { TEST_ENVIRONMENT } from "../../../../scripts/test-isolation.ts";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zinn-opencode-release-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test.each(["0.1.0-dev", "0.2.0-alpha.1", "0.2.0-rc.1"])("publication refuses prerelease %s", (version) => {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: manifest.name, version }));
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../checks/release.ts")], {
    cwd: directory, env: TEST_ENVIRONMENT,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(manifest.name);
  expect(result.stderr.toString()).toContain(version);
});

test("the reviewed release version passes the version gate without publishing", () => {
  const releaseVersion = manifest.version.replace(/-dev$/, "");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ ...manifest, version: releaseVersion }));
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../checks/release.ts")], {
    cwd: directory, env: TEST_ENVIRONMENT,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});
