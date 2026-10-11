import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  // ? A temporary cwd, so a zinn.local.json in the checkout running the tests cannot choose the store.
  const cwd = mkdtempSync(join(tmpdir(), "zinn-constant-cwd-"));

  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      const { getStorage } = await import(${constantModule});
      console.log(getStorage().directory);
    `], { env: childEnvironment, cwd });

    return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

  expect(resolveStorage({ cwd: home, env: { ZINN_DIR: directory, NODE_ENV: "test" }, home })).toEqual({
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

  expect(resolveStorage({ cwd: home, env: {}, home })).toEqual({
    directory: defaultDirectory,
    source: "default",
    dataDirectory: join(defaultDirectory, "data"),
    databasePath: join(defaultDirectory, "data", "zinn.sqlite"),
    backupDirectory: join(defaultDirectory, "backups"),
    defaultDirectory,
  });
});

test("the resolver refuses a test run's default folder outside the temporary directory, without a child process", () => {
  const cwd = join(tmpdir(), "zinn-constant-unused-cwd");

  expect(() => resolveStorage({ cwd, env: { NODE_ENV: "test" }, home: USER_HOME })).toThrow(
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
      const { directory, source } = core.getStorage();
      console.log(JSON.stringify({ directory, source, sameOnReuse: core.getStorage() === core.getStorage() }));
    `], { env: { ...childEnvironment, NODE_ENV: "test", HOME: USER_HOME }, cwd: directory });

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

// ? ZINN-56: the settings files choose the store, below ZINN_DIR. Temporary folders only.
function withRoot(check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "zinn-constant-settings-"));

  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSettings(path: string, content: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function storageSettings(directory: string) {
  return { storage: { directory } };
}

/** A repository with a .git folder, its zinn.local.json and the global settings file of a home inside root. */
function layout(root: string) {
  const home = join(root, "home");
  const repository = join(root, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });

  return {
    home,
    repository,
    globalFile: join(home, ".zinn", "settings.json"),
    localFile: join(repository, "zinn.local.json"),
  };
}

test("ZINN_DIR wins over storage.directory in both settings files", () => {
  withRoot((root) => {
    const { home, repository, localFile } = layout(root);
    const zinnDirectory = join(root, "env-store");
    writeSettings(join(zinnDirectory, "settings.json"), storageSettings("global-store"));
    writeSettings(localFile, storageSettings("local-store"));

    const storage = resolveStorage({ cwd: repository, env: { ZINN_DIR: zinnDirectory }, home });

    expect(storage.source).toBe("env");
    expect(storage.directory).toBe(zinnDirectory);
  });
});

test("the per-codebase file wins over the global file, and the global file over the default folder", () => {
  withRoot((root) => {
    const { home, repository, globalFile, localFile } = layout(root);
    writeSettings(globalFile, storageSettings("global-store"));

    expect(resolveStorage({ cwd: repository, env: {}, home })).toEqual({
      directory: join(home, ".zinn", "global-store"),
      source: "global",
      dataDirectory: join(home, ".zinn", "global-store", "data"),
      databasePath: join(home, ".zinn", "global-store", "data", "zinn.sqlite"),
      backupDirectory: join(home, ".zinn", "global-store", "backups"),
      defaultDirectory: join(home, ".zinn"),
    });

    writeSettings(localFile, storageSettings("local-store"));
    const storage = resolveStorage({ cwd: repository, env: {}, home });

    expect(storage.source).toBe("local");
    expect(storage.directory).toBe(join(repository, "local-store"));
  });
});

test("without settings files the store is the default folder, and no settings file is created", () => {
  withRoot((root) => {
    const { home, repository, globalFile } = layout(root);

    const storage = resolveStorage({ cwd: repository, env: {}, home });

    expect(storage.source).toBe("default");
    expect(storage.directory).toBe(join(home, ".zinn"));
    expect(existsSync(globalFile)).toBe(false);
    expect(existsSync(join(home, ".zinn"))).toBe(false);
  });
});

test("a relative storage.directory gives the same store from any subfolder of the repository", () => {
  withRoot((root) => {
    const { home, repository, localFile } = layout(root);
    const nested = join(repository, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeSettings(localFile, storageSettings("../stores/app"));

    for (const cwd of [repository, join(repository, "packages"), nested]) {
      expect(resolveStorage({ cwd, env: {}, home }).directory).toBe(join(root, "stores", "app"));
    }
  });
});

test("~ and ~/ in storage.directory start at the given home, and any other value is used as written", () => {
  withRoot((root) => {
    const { home, repository, globalFile, localFile } = layout(root);
    const directoryFor = (directory: string) => {
      writeSettings(localFile, storageSettings(directory));
      return resolveStorage({ cwd: repository, env: {}, home }).directory;
    };

    expect(directoryFor("~")).toBe(home);
    expect(directoryFor("~/stores/app")).toBe(join(home, "stores", "app"));
    expect(directoryFor("~user/store")).toBe(join(repository, "~user", "store"));
    expect(directoryFor("stores/~/app")).toBe(join(repository, "stores", "~", "app"));
    expect(directoryFor(join(root, "absolute"))).toBe(join(root, "absolute"));

    rmSync(localFile);
    writeSettings(globalFile, storageSettings("~/from-global"));

    expect(resolveStorage({ cwd: repository, env: {}, home }).directory).toBe(join(home, "from-global"));
  });
});

test("an invalid codebase settings file fails without ZINN_DIR and is ignored with it", () => {
  withRoot((root) => {
    const { home, repository, localFile } = layout(root);
    writeSettings(localFile, { storage: { directory: 42 } });

    expect(() => resolveStorage({ cwd: repository, env: {}, home })).toThrow(`Cannot use settings file ${localFile}`);

    const zinnDirectory = join(root, "env-store");
    expect(resolveStorage({ cwd: repository, env: { ZINN_DIR: zinnDirectory }, home }).directory).toBe(zinnDirectory);
    expect(existsSync(zinnDirectory)).toBe(false);
  });
});

test("invalid settings in the ZINN_DIR directory fail with that file's path", () => {
  withRoot((root) => {
    const { home, repository } = layout(root);
    const zinnDirectory = join(root, "env-store");
    const settingsFile = join(zinnDirectory, "settings.json");
    writeSettings(settingsFile, { defaultProject: 42 });

    expect(() => resolveStorage({ cwd: repository, env: { ZINN_DIR: zinnDirectory }, home })).toThrow(
      `Cannot use settings file ${settingsFile}`,
    );
    expect(existsSync(join(zinnDirectory, "data"))).toBe(false);
  });
});

test("a test run refuses a store chosen by a settings file outside the temporary directory, naming the file", () => {
  withRoot((root) => {
    const { home, repository, globalFile, localFile } = layout(root);
    // ? Resolution creates nothing, so this folder is only named, never made.
    const outside = join(USER_HOME, "zinn-test-store-never-created");
    const testRun = { NODE_ENV: "test" };

    writeSettings(globalFile, storageSettings(outside));
    expect(() => resolveStorage({ cwd: repository, env: testRun, home })).toThrow(
      `Refusing to use ${outside}, chosen by the settings file ${globalFile}, in a test run`,
    );

    writeSettings(localFile, storageSettings(outside));
    expect(() => resolveStorage({ cwd: repository, env: testRun, home })).toThrow(
      `Refusing to use ${outside}, chosen by the settings file ${localFile}, in a test run`,
    );
    expect(existsSync(outside)).toBe(false);
  });
});

test("a test run allows a settings-chosen store inside the temporary directory, and other runs allow any", () => {
  withRoot((root) => {
    const { home, repository, localFile } = layout(root);
    const outside = join(USER_HOME, "zinn-test-store-never-created");

    writeSettings(localFile, storageSettings("store"));
    expect(resolveStorage({ cwd: repository, env: { NODE_ENV: "test" }, home }).directory).toBe(
      join(repository, "store"),
    );

    writeSettings(localFile, storageSettings(outside));
    expect(resolveStorage({ cwd: repository, env: {}, home }).directory).toBe(outside);
    expect(existsSync(outside)).toBe(false);
  });
});

test("importing core reads no settings file, so a zinn.local.json written after the import is the one used", () => {
  withRoot((root) => {
    const coreModule = JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)));
    const { home, repository, localFile } = layout(root);
    const childEnvironment: Record<string, string | undefined> = { ...process.env };
    delete childEnvironment.ZINN_DIR;

    // ? The child starts in an empty folder, then writes the file and moves into the repository.
    const result = Bun.spawnSync([process.execPath, "--eval", `
      const { writeFileSync } = await import("node:fs");
      const core = await import(${coreModule});
      writeFileSync(${JSON.stringify(localFile)}, JSON.stringify({ storage: { directory: "store" } }));
      process.chdir(${JSON.stringify(repository)});
      const { directory, source } = core.getStorage();
      console.log(JSON.stringify({ directory, source }));
    `], { env: { ...childEnvironment, NODE_ENV: "test", HOME: home }, cwd: home });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    // ? process.cwd() gives the real path, so the store is under the repository's real path.
    expect(JSON.parse(result.stdout.toString())).toEqual({
      directory: join(realpathSync(repository), "store"),
      source: "local",
    });
  });
});
