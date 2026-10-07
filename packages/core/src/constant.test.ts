import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStorage } from "./constant";

// ? ZINN-172: a test run that misses ZINN_DIR must fail, not fall back to the user's own database.
// ? Each child only imports and resolves, which reads and writes no files, so a broken guard cannot reach ~/.zinn.
const constantModule = JSON.stringify(fileURLToPath(new URL("./constant.ts", import.meta.url)));
const USER_HOME = homedir();

function resolveMainDir(environment: Record<string, string | undefined>) {
  const childEnvironment: Record<string, string | undefined> = { ...process.env, ...environment };
  delete childEnvironment.ZINN_DIR;
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (value === undefined) {
      delete childEnvironment[name];
    }
  }

  const result = Bun.spawnSync([process.execPath, "--eval", `
    const { storage } = await import(${constantModule});
    console.log(storage().directory);
  `], { env: childEnvironment });

  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

test("a test run without ZINN_DIR refuses the user's own default folder", () => {
  const result = resolveMainDir({ NODE_ENV: "test", HOME: USER_HOME });

  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Refusing to use ${join(USER_HOME, ".zinn")} in a test run`);
});

test("a test run with a temporary HOME gets that HOME's default folder", () => {
  const home = mkdtempSync(join(tmpdir(), "zinn-constant-home-"));

  try {
    expect(resolveMainDir({ NODE_ENV: "test", HOME: home })).toEqual({
      code: 0,
      stdout: join(home, ".zinn"),
      stderr: "",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("outside a test run the user's own default folder is used", () => {
  expect(resolveMainDir({ NODE_ENV: undefined, HOME: USER_HOME })).toEqual({
    code: 0,
    stdout: join(USER_HOME, ".zinn"),
    stderr: "",
  });
});

test("ZINN_DIR gives an env store in that folder, with its paths inside it", () => {
  const home = join(tmpdir(), "zinn-constant-unused-home");
  const directory = join(tmpdir(), "zinn-constant-store");

  expect(resolveStorage({ env: { ZINN_DIR: directory, NODE_ENV: "test" }, home })).toEqual({
    directory,
    source: "env",
    dataDirectory: join(directory, "data"),
    databasePath: join(directory, "data", "zinn.sqlite"),
    backupDirectory: join(directory, "backups"),
    defaultDirectory: join(home, ".zinn"),
  });
});

test("without ZINN_DIR the store is the default folder in the given home", () => {
  const home = join(tmpdir(), "zinn-constant-home");
  const defaultDirectory = join(home, ".zinn");

  expect(resolveStorage({ env: {}, home })).toEqual({
    directory: defaultDirectory,
    source: "default",
    dataDirectory: join(defaultDirectory, "data"),
    databasePath: join(defaultDirectory, "data", "zinn.sqlite"),
    backupDirectory: join(defaultDirectory, "backups"),
    defaultDirectory,
  });
});

test("the resolver refuses a test run's default folder outside the temporary directory, without a child process", () => {
  expect(() => resolveStorage({ env: { NODE_ENV: "test" }, home: USER_HOME })).toThrow(
    `Refusing to use ${join(USER_HOME, ".zinn")} in a test run`,
  );
});

test("importing core resolves nothing, so a ZINN_DIR set after the import is the one used", () => {
  const coreModule = JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), "zinn-constant-lazy-"));
  const later = join(directory, "later");
  const childEnvironment: Record<string, string | undefined> = { ...process.env };
  delete childEnvironment.ZINN_DIR;

  try {
    // ? Without ZINN_DIR at import, an eager resolution would throw the test-run refusal for this HOME.
    const result = Bun.spawnSync([process.execPath, "--eval", `
      const core = await import(${coreModule});
      process.env.ZINN_DIR = ${JSON.stringify(later)};
      const { directory, source } = core.storage();
      console.log(JSON.stringify({ directory, source, sameOnReuse: core.storage() === core.storage() }));
    `], { env: { ...childEnvironment, NODE_ENV: "test", HOME: USER_HOME } });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      directory: later,
      source: "env",
      sameOnReuse: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
