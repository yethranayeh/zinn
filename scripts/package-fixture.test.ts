import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createPackageFixture, PACKAGE_NAMES, readNodeMinimum } from "./package-fixture.ts";

function write(directory: string, path: string, content: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content);
}

function runGit(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: directory });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

test("package fixtures include current build inputs, omit ignored files and support nested snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-package-fixture-"));
  const source = join(root, "source");
  const fixture = join(root, "fixture");
  const nested = join(root, "nested");

  try {
    mkdirSync(source);
    runGit(source, ["init", "--quiet", "--template="]);
    write(source, ".gitignore", "node_modules/\ndist/\n");
    for (const name of PACKAGE_NAMES) {
      write(source, `packages/${name}/package.json`, JSON.stringify({ name, engines: { node: ">=24.0.0" } }));
    }
    write(source, "scripts/build.ts", "original build input\n");
    write(source, "deleted.txt", "removed build input\n");
    runGit(source, ["add", "--all"]);
    const sourceIndex = readFileSync(join(source, ".git/index"));
    write(source, "scripts/build.ts", "changed working-tree input\n");
    write(source, "packages/core/assets/new.txt", "new untracked build input\n");
    write(source, ".git/info/exclude", ".private.txt\n");
    write(source, ".private.txt", "ignored input\n");
    write(source, "packages/core/dist/stale.js", "stale generated output\n");
    mkdirSync(join(source, "node_modules"));
    mkdirSync(join(source, "packages/core/node_modules"));
    rmSync(join(source, "deleted.txt"));

    createPackageFixture(source, fixture);
    expect(readFileSync(join(fixture, "scripts/build.ts"))).toEqual(readFileSync(join(source, "scripts/build.ts")));
    expect(readFileSync(join(fixture, "packages/core/assets/new.txt"))).toEqual(readFileSync(join(source, "packages/core/assets/new.txt")));
    expect(existsSync(join(fixture, ".private.txt"))).toBe(false);
    expect(existsSync(join(fixture, "packages/core/dist"))).toBe(false);
    expect(existsSync(join(fixture, "deleted.txt"))).toBe(false);
    expect(realpathSync(join(fixture, "packages/cli/node_modules/@zinn-dev/core"))).toBe(realpathSync(join(fixture, "packages/core")));
    expect(readFileSync(join(source, ".git/index"))).toEqual(sourceIndex);

    write(fixture, "scripts/build.ts", "changed snapshot input\n");
    write(fixture, "scripts/another-helper.ts", "another untracked input\n");
    createPackageFixture(fixture, nested);
    for (const path of ["scripts/build.ts", "scripts/another-helper.ts", "packages/core/assets/new.txt"]) {
      expect(readFileSync(join(nested, path))).toEqual(readFileSync(join(fixture, path)));
    }
    expect(realpathSync(join(nested, "packages/cli/node_modules/@zinn-dev/core"))).toBe(realpathSync(join(nested, "packages/core")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node verification follows matching package engine minimums and refuses incompatible declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-node-minimum-"));
  const setRequirements = (core: string | undefined, cli = core) => {
    const requirements = { core, cli };
    for (const name of PACKAGE_NAMES) {
      write(root, `packages/${name}/package.json`, JSON.stringify({ engines: { node: requirements[name] } }));
    }
  };

  try {
    setRequirements(">=24.0.0");
    expect(readNodeMinimum(root)).toEqual({ version: "24.0.0", major: 24 });
    setRequirements(">=26.3.1");
    expect(readNodeMinimum(root)).toEqual({ version: "26.3.1", major: 26 });
    setRequirements(">=24.0.0", ">=26.0.0");
    expect(() => readNodeMinimum(root)).toThrow();
    setRequirements(undefined);
    expect(() => readNodeMinimum(root)).toThrow();
    setRequirements("^24");
    expect(() => readNodeMinimum(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
