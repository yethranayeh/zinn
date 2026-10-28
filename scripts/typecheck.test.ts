import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./package-fixture.ts";
import { TEST_ENVIRONMENT } from "./test-isolation.ts";

const repositoryDirectory = join(import.meta.dir, "..");
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zinn-typecheck-"));
  git(directory, ["init", "--quiet", "--template="]);
  writeFileSync(join(directory, ".gitignore"), "node_modules/\n*.local.ts\n");
  mkdirSync(join(directory, ".git/info"));
  writeFileSync(join(directory, ".git/info/exclude"), "scripts/\nresearch/\n");
  mkdirSync(join(directory, "scripts"));
  for (const name of ["typecheck.ts", "package-fixture.ts"]) {
    copyFileSync(join(import.meta.dir, name), join(directory, "scripts", name));
  }
  symlinkSync(
    join(repositoryDirectory, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: "ESNext",
        types: [],
      },
    }),
  );
  writeFileSync(join(directory, "retained.ts"), "export const retained: number = 1;\n");
  git(directory, ["add", "--all"]);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function runTypecheck() {
  const indexPath = join(directory, ".git/index");
  const indexBefore = readFileSync(indexPath);
  const result = Bun.spawnSync([process.execPath, "scripts/typecheck.ts"], {
    cwd: directory,
    env: TEST_ENVIRONMENT,
  });
  expect(readFileSync(indexPath)).toEqual(indexBefore);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("typecheck checks an unstaged rename without requiring the deleted root", () => {
  const originalPath = join(directory, "original.ts");
  const replacementPath = join(directory, "renamed file.ts");
  writeFileSync(originalPath, "export const value: number = 1;\n");
  git(directory, ["add", "original.ts"]);
  renameSync(originalPath, replacementPath);

  const valid = runTypecheck();
  expect(valid.exitCode).toBe(0);
  expect(valid.stdout).toBe("");
  expect(valid.stderr).toBe("");

  writeFileSync(replacementPath, 'export const value: number = "invalid";\n');
  const invalid = runTypecheck();
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("renamed file.ts");
  expect(invalid.stderr).toContain("TS2322");
  expect(invalid.stderr).not.toContain("TS6053");
});

test("typecheck rejects errors in new files and current tracked contents, and skips deletions", () => {
  const newPath = join(directory, "new.ts");
  writeFileSync(newPath, 'export const value: number = "invalid";\n');
  const untracked = runTypecheck();
  expect(untracked.exitCode).toBe(1);
  expect(untracked.stderr).toContain("new.ts");
  expect(untracked.stderr).toContain("TS2322");
  rmSync(newPath);

  const trackedPath = join(directory, "retained.ts");
  writeFileSync(trackedPath, 'export const retained: number = "invalid";\n');
  const modified = runTypecheck();
  expect(modified.exitCode).toBe(1);
  expect(modified.stderr).toContain("retained.ts");
  expect(modified.stderr).toContain("TS2322");
  writeFileSync(trackedPath, "export const retained: number = 1;\n");

  writeFileSync(newPath, 'export const value: number = "invalid";\n');
  git(directory, ["add", "new.ts"]);
  rmSync(newPath);
  const deleted = runTypecheck();
  expect(deleted.exitCode).toBe(0);
  expect(deleted.stderr).toBe("");
});

test("typecheck excludes website roots and files ignored by Git", () => {
  mkdirSync(join(directory, "docs"));
  mkdirSync(join(directory, "research"));
  const invalidSource = 'export const value: number = "invalid";\n';
  writeFileSync(join(directory, "docs/tracked.ts"), invalidSource);
  git(directory, ["add", "docs/tracked.ts"]);
  writeFileSync(join(directory, "docs/untracked.ts"), invalidSource);
  writeFileSync(join(directory, "research/private.ts"), invalidSource);
  writeFileSync(join(directory, "settings.local.ts"), invalidSource);

  const result = runTypecheck();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("the inspector compiler owns every current TypeScript file in its project", () => {
  const inspector = join(directory, "integrations/opencode/inspector");
  mkdirSync(join(inspector, "pkg"), { recursive: true });
  mkdirSync(join(inspector, "tests"));
  writeFileSync(
    join(inspector, "tsconfig.json"),
    JSON.stringify({
      extends: "../../../tsconfig.json",
      include: ["pkg/**/*.ts"],
    }),
  );
  writeFileSync(join(inspector, "pkg/source.ts"), "export const valid: number = 1;\n");
  git(directory, ["add", "integrations"]);
  writeFileSync(join(inspector, "tests/untracked.ts"), 'export const invalid: number = "wrong";\n');

  const root = runTypecheck();
  expect(root.exitCode).toBe(0);
  const inspectorCheck = Bun.spawnSync(
    [process.execPath, "scripts/typecheck.ts", "integrations/opencode/inspector"],
    {
      cwd: directory,
      env: TEST_ENVIRONMENT,
    },
  );
  expect(inspectorCheck.exitCode).toBe(1);
  expect(inspectorCheck.stderr.toString()).toContain("untracked.ts");
  expect(inspectorCheck.stderr.toString()).toContain("TS2322");
  writeFileSync(join(inspector, "tests/untracked.ts"), "export const valid: number = 1;\n");
  const valid = Bun.spawnSync(
    [process.execPath, "scripts/typecheck.ts", "integrations/opencode/inspector"],
    {
      cwd: directory,
      env: TEST_ENVIRONMENT,
    },
  );
  expect(valid.exitCode).toBe(0);
});
