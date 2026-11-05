import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import manifest from "../package.json";
import { latestReleaseVersion } from "../../../../docs/src/config/latest-release.ts";
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

test("the public install examples name the current release version", () => {
  // During a development cycle the package is unpublished, so the examples keep the last release.
  const version = manifest.version.includes("-")
    ? latestReleaseVersion("opencode")
    : manifest.version;
  const readmes = [
    resolve(import.meta.dir, "../../../../README.md"),
    resolve(import.meta.dir, "../README.md"),
  ];

  for (const readme of readmes) {
    expect(readFileSync(readme, "utf8")).toContain(`@zinn-dev/opencode@${version}`);
  }
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
