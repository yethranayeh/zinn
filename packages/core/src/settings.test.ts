import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSettings } from "./settings";

// ? ZINN-56: settings discovery, parsing and merging, with temporary folders only.
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zinn-settings-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, content: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function globalFile(content: unknown) {
  writeJson(join(home, ".zinn", "settings.json"), content);
}

function storageSettings(directory: string) {
  return { storage: { directory } };
}

/** Every file and folder under `directory`, to prove that reading settings leaves a folder as it was. */
function listTree(directory: string) {
  return readdirSync(directory, { recursive: true }).map(String).sort();
}

test("without any settings file nothing is found", () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);

  expect(resolveSettings({ cwd, env: {}, home })).toEqual({ global: null, local: null, merged: {} });
});

test("the global file is settings.json in the default folder of the home", () => {
  globalFile(storageSettings("global-store"));
  const cwd = join(root, "project");
  mkdirSync(cwd);

  expect(resolveSettings({ cwd, env: {}, home })).toEqual({
    global: { path: join(home, ".zinn", "settings.json"), settings: storageSettings("global-store") },
    local: null,
    merged: storageSettings("global-store"),
  });
});

test("ZINN_DIR moves the global file and the default folder is not read", () => {
  const zinnDirectory = join(root, "elsewhere");
  globalFile(storageSettings("ignored"));
  writeJson(join(zinnDirectory, "settings.json"), storageSettings("moved"));
  const cwd = join(root, "project");
  mkdirSync(cwd);

  const resolved = resolveSettings({ cwd, env: { ZINN_DIR: zinnDirectory }, home });

  expect(resolved.global).toEqual({ path: join(zinnDirectory, "settings.json"), settings: storageSettings("moved") });
  expect(resolved.merged).toEqual(storageSettings("moved"));
});

test("ZINN_DIR uses only its settings, even when codebase and home settings are invalid", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const localPath = join(cwd, "zinn.local.json");
  const zinnDirectory = join(root, "isolated");
  const settingsPath = join(zinnDirectory, "settings.json");
  globalFile("invalid JSON");
  writeJson(localPath, { defaultProject: "LOCAL" });
  writeJson(settingsPath, { defaultProject: "SELECTED" });

  const inputs = { cwd, env: { ZINN_DIR: zinnDirectory }, home };
  expect(resolveSettings(inputs)).toEqual({
    global: { path: settingsPath, settings: { defaultProject: "SELECTED" } },
    local: null,
    merged: { defaultProject: "SELECTED" },
  });

  writeJson(localPath, "invalid JSON");
  expect(resolveSettings(inputs).merged).toEqual({ defaultProject: "SELECTED" });

  rmSync(settingsPath);
  expect(resolveSettings(inputs)).toEqual({ global: null, local: null, merged: {} });

  writeJson(settingsPath, { defaultProject: 42 });
  expect(() => resolveSettings(inputs)).toThrow(settingsPath);
});

test("zinn.local.json in the working folder is found", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeJson(join(cwd, "zinn.local.json"), storageSettings("local-store"));

  expect(resolveSettings({ cwd, env: {}, home })).toEqual({
    global: null,
    local: { path: join(cwd, "zinn.local.json"), settings: storageSettings("local-store") },
    merged: storageSettings("local-store"),
  });
});

test("zinn.local.json in an ancestor below the Git root is found", () => {
  const repository = join(root, "repository");
  const cwd = join(repository, "packages", "app", "src");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(repository, "packages", "zinn.local.json"), storageSettings("middle"));

  expect(resolveSettings({ cwd, env: {}, home }).local?.path).toBe(join(repository, "packages", "zinn.local.json"));
});

test("zinn.local.json in the Git root is found", () => {
  const repository = join(root, "repository");
  const cwd = join(repository, "src");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(repository, "zinn.local.json"), storageSettings("root"));

  expect(resolveSettings({ cwd, env: {}, home }).local?.path).toBe(join(repository, "zinn.local.json"));
});

test("the nearest zinn.local.json wins and is not merged with the Git root's", () => {
  const repository = join(root, "repository");
  const nested = join(repository, "packages", "app");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeJson(join(repository, "zinn.local.json"), storageSettings("root"));
  writeJson(join(repository, "packages", "zinn.local.json"), { $schema: "near" });

  const resolved = resolveSettings({ cwd: nested, env: {}, home });

  expect(resolved.local).toEqual({ path: join(repository, "packages", "zinn.local.json"), settings: { $schema: "near" } });
  expect(resolved.merged).toEqual({});
});

test("a zinn.local.json above the Git root is ignored", () => {
  const outer = join(root, "outer");
  const repository = join(outer, "repository");
  const cwd = join(repository, "src");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(outer, "zinn.local.json"), storageSettings("above"));

  expect(resolveSettings({ cwd, env: {}, home }).local).toBeNull();
});

test("outside a repository only the working folder counts", () => {
  const parent = join(root, "plain");
  const cwd = join(parent, "child");
  mkdirSync(cwd, { recursive: true });
  writeJson(join(parent, "zinn.local.json"), storageSettings("parent"));

  expect(resolveSettings({ cwd, env: {}, home }).local).toBeNull();

  writeJson(join(cwd, "zinn.local.json"), storageSettings("child"));

  expect(resolveSettings({ cwd, env: {}, home }).local?.path).toBe(join(cwd, "zinn.local.json"));
});

test("a .git file, as in a worktree or submodule, marks the Git root", () => {
  const outer = join(root, "outer");
  const worktree = join(outer, "worktree");
  const cwd = join(worktree, "src");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/else\n");
  writeJson(join(outer, "zinn.local.json"), storageSettings("above"));
  writeJson(join(worktree, "zinn.local.json"), storageSettings("worktree"));

  expect(resolveSettings({ cwd, env: {}, home }).local?.path).toBe(join(worktree, "zinn.local.json"));

  rmSync(join(worktree, "zinn.local.json"));

  expect(resolveSettings({ cwd, env: {}, home }).local).toBeNull();
});

test("local fields override global ones and global fields the local file leaves out survive", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  globalFile({ $schema: "global", storage: { directory: "global-store" } });
  writeJson(join(cwd, "zinn.local.json"), storageSettings("local-store"));

  expect(resolveSettings({ cwd, env: {}, home }).merged).toEqual(storageSettings("local-store"));

  writeJson(join(cwd, "zinn.local.json"), { $schema: "local" });

  expect(resolveSettings({ cwd, env: {}, home }).merged).toEqual(storageSettings("global-store"));
});

test("a settings file that is not valid JSON throws an error naming the file", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(cwd, "zinn.local.json");
  writeJson(path, '{ "storage": ');

  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(`Cannot use settings file ${path}: it is not valid JSON`);
});

test("defaultProject merges independently of storage and preserves the chosen key", () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  globalFile({ defaultProject: "GLOBAL", storage: { directory: "global-store" } });
  writeJson(join(cwd, "zinn.local.json"), { defaultProject: "local" });

  expect(resolveSettings({ cwd, env: {}, home }).merged).toEqual({
    defaultProject: "local",
    storage: { directory: "global-store" },
  });

  writeJson(join(cwd, "zinn.local.json"), storageSettings("local-store"));
  expect(resolveSettings({ cwd, env: {}, home }).merged).toEqual({
    defaultProject: "GLOBAL",
    storage: { directory: "local-store" },
  });
});

test("defaultProject validates project key format and reports its settings file", () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const path = join(cwd, "zinn.local.json");
  for (const defaultProject of [null, 42, "", "1SHOP", "SHOP-1", "two words"]) {
    writeJson(path, { defaultProject });
    try {
      resolveSettings({ cwd, env: {}, home });
      throw new Error("Expected invalid settings to be refused");
    } catch (error) {
      expect(String(error)).toContain(path);
      expect(String(error)).toContain("defaultProject");
    }
  }
});

test("an unknown key, at the top or inside storage, throws an error naming the file and the key", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(cwd, "zinn.local.json");

  writeJson(path, { storge: { directory: "store" } });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(new RegExp(`${path}.*Unrecognized key: "storge"`, "s"));

  writeJson(path, { storage: { directory: "store", path: "x" } });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(new RegExp(`${path}.*Unrecognized key: "path".*storage`, "s"));
});

test("a wrong type or a storage without a directory throws an error naming the file and the setting", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(cwd, "zinn.local.json");

  writeJson(path, { storage: { directory: 42 } });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(new RegExp(`${path}.*storage.directory`, "s"));

  writeJson(path, { storage: {} });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(new RegExp(`${path}.*storage.directory`, "s"));
});

test("an invalid global file throws an error naming the global file", () => {
  globalFile("not json");

  expect(() => resolveSettings({ cwd: root, env: {}, home })).toThrow(join(home, ".zinn", "settings.json"));
});

test("a settings file that exists but cannot be read throws instead of counting as missing", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(cwd, "zinn.local.json");
  mkdirSync(path);

  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(`Cannot use settings file ${path}: it cannot be read`);
});

test("reading settings creates no file or folder", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const before = listTree(root);

  resolveSettings({ cwd, env: {}, home });
  resolveSettings({ cwd, env: { ZINN_DIR: join(root, "not-created") }, home });

  expect(listTree(root)).toEqual(before);

  globalFile(storageSettings("store"));
  writeJson(join(cwd, "zinn.local.json"), storageSettings("local"));
  const withFiles = listTree(root);

  resolveSettings({ cwd, env: {}, home });

  expect(listTree(root)).toEqual(withFiles);
});

test("a ZINN_DIR that is a file has no global settings file, so the store's own error reports it", () => {
  const zinnDirectory = join(root, "a-file");
  writeFileSync(zinnDirectory, "not a folder");

  expect(resolveSettings({ cwd: root, env: { ZINN_DIR: zinnDirectory }, home }).global).toBeNull();
});
