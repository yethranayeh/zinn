import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createPackageTestCopy, git, GIT_CONTEXT_VARIABLES, PACKAGE_NAMES, readNodeMinimum } from "./package-fixture.ts";

function write(directory: string, path: string, content: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content);
}

test("temporary package copies include current build inputs, omit ignored files and can be copied again", () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-package-fixture-"));
  const source = join(root, "source");
  const fixture = join(root, "fixture");
  const nested = join(root, "nested");

  try {
    mkdirSync(source);
    git(source, ["init", "--quiet", "--template="]);
    write(source, ".gitignore", "node_modules/\ndist/\n");
    for (const name of PACKAGE_NAMES) {
      write(source, `packages/${name}/package.json`, JSON.stringify({ name, engines: { node: ">=24.0.0" } }));
    }
    write(source, "scripts/build.ts", "original build input\n");
    write(source, "deleted.txt", "removed build input\n");
    git(source, ["add", "--all"]);
    const sourceIndex = readFileSync(join(source, ".git/index"));
    write(source, "scripts/build.ts", "changed working-tree input\n");
    write(source, "packages/core/assets/new.txt", "new untracked build input\n");
    write(source, ".git/info/exclude", ".private.txt\n");
    write(source, ".private.txt", "ignored input\n");
    write(source, "packages/core/dist/stale.js", "stale generated output\n");
    mkdirSync(join(source, "node_modules"));
    mkdirSync(join(source, "packages/core/node_modules"));
    rmSync(join(source, "deleted.txt"));

    createPackageTestCopy(source, fixture);
    expect(readFileSync(join(fixture, "scripts/build.ts"))).toEqual(readFileSync(join(source, "scripts/build.ts")));
    expect(readFileSync(join(fixture, "packages/core/assets/new.txt"))).toEqual(readFileSync(join(source, "packages/core/assets/new.txt")));
    expect(existsSync(join(fixture, ".private.txt"))).toBe(false);
    expect(existsSync(join(fixture, "packages/core/dist"))).toBe(false);
    expect(existsSync(join(fixture, "deleted.txt"))).toBe(false);
    expect(realpathSync(join(fixture, "packages/cli/node_modules/@zinn-dev/core"))).toBe(realpathSync(join(fixture, "packages/core")));
    expect(readFileSync(join(source, ".git/index"))).toEqual(sourceIndex);

    write(fixture, "scripts/build.ts", "changed snapshot input\n");
    write(fixture, "scripts/another-helper.ts", "another untracked input\n");
    createPackageTestCopy(fixture, nested);
    for (const path of ["scripts/build.ts", "scripts/another-helper.ts", "packages/core/assets/new.txt"]) {
      expect(readFileSync(join(nested, path))).toEqual(readFileSync(join(fixture, path)));
    }
    expect(realpathSync(join(nested, "packages/cli/node_modules/@zinn-dev/core"))).toBe(realpathSync(join(nested, "packages/core")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary repository setup ignores inherited Git paths", () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-git-context-"));
  const foreign = join(root, "foreign");
  const fixture = join(root, "fixture");
  const previousEnvironment = Object.fromEntries(GIT_CONTEXT_VARIABLES.map((name) => [name, process.env[name]]));

  try {
    mkdirSync(foreign);
    mkdirSync(fixture);
    git(foreign, ["init", "--quiet", "--template="]);
    write(foreign, "retained.txt", "retained data\n");
    git(foreign, ["add", "--all"]);
    const foreignIndex = readFileSync(join(foreign, ".git/index"));
    const foreignData = readFileSync(join(foreign, "retained.txt"));
    const redirectedEnvironment = {
      GIT_DIR: join(foreign, ".git"),
      GIT_COMMON_DIR: join(foreign, ".git"),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: join(foreign, ".git/index"),
    };
    for (const name of GIT_CONTEXT_VARIABLES) {
      process.env[name] = redirectedEnvironment[name];
    }

    git(fixture, ["init", "--quiet", "--template="]);
    write(fixture, "fixture.txt", "fixture data\n");
    git(fixture, ["add", "--all"]);
    expect(git(fixture, ["ls-files"]).trim()).toBe("fixture.txt");
    expect(readFileSync(join(foreign, ".git/index"))).toEqual(foreignIndex);
    expect(readFileSync(join(foreign, "retained.txt"))).toEqual(foreignData);
    expect(existsSync(join(foreign, "fixture.txt"))).toBe(false);
  } finally {
    for (const name of GIT_CONTEXT_VARIABLES) {
      const previous = previousEnvironment[name];
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
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
