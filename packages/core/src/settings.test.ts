import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BYTES_PER_MEGABYTE, chooseDefaultProject, DEFAULT_TELEMETRY_MAX_MEGABYTES, inspectSettings, resolveSettings, resolveTelemetry } from "./settings";

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

  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_json" }), cause: expect.any(SyntaxError) }));
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

test("the chosen defaultProject comes from the codebase file before the global one, with the path of the file that sets it", () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const globalPath = join(home, ".zinn", "settings.json");
  const localPath = join(cwd, "zinn.local.json");

  expect(chooseDefaultProject(resolveSettings({ cwd, env: {}, home }))).toBeNull();

  globalFile({ defaultProject: "GLOBAL" });
  writeJson(localPath, storageSettings("local-store"));
  expect(chooseDefaultProject(resolveSettings({ cwd, env: {}, home }))).toEqual({
    key: "GLOBAL",
    settingsPath: globalPath,
  });

  writeJson(localPath, { defaultProject: "LOCAL" });
  expect(chooseDefaultProject(resolveSettings({ cwd, env: {}, home }))).toEqual({
    key: "LOCAL",
    settingsPath: localPath,
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
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_settings", field: [] }), cause: expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", keys: ["storge"] })]) }) }));

  writeJson(path, { storage: { directory: "store", path: "x" } });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_settings", field: ["storage"] }), cause: expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", keys: ["path"] })]) }) }));
});

test("a wrong type or a storage without a directory throws an error naming the file and the setting", () => {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(cwd, "zinn.local.json");

  writeJson(path, { storage: { directory: 42 } });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_settings", field: ["storage", "directory"] }) }));

  writeJson(path, { storage: {} });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_settings", field: ["storage", "directory"] }) }));
});

test("ZINN-161: hooks are read from the global file and refused in zinn.local.json", () => {
  const hooks = { notify: { command: "cat > /dev/null", timeout: 0.5 } };
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  globalFile({ hooks });

  const resolved = resolveSettings({ cwd, env: {}, home });
  expect(resolved.global?.settings.hooks).toEqual(hooks);
  expect(resolved.merged).toEqual({});

  const path = join(cwd, "zinn.local.json");
  writeJson(path, { hooks });
  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "input", facts: expect.objectContaining({ settingsPath: path, reason: "invalid_settings", field: ["hooks"] }) }));
  expect(inspectSettings({ cwd, env: {}, home }).files).toContainEqual(expect.objectContaining({ path, source: "local", state: "error" }));
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

  expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ kind: "storage", facts: expect.objectContaining({ settingsPath: path }), cause: expect.objectContaining({ code: "EISDIR" }) }));
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

// ? ZINN-347: the telemetry setting and its resolution with DO_NOT_TRACK.
function telemetryProject() {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, localPath: join(cwd, "zinn.local.json"), globalPath: join(home, ".zinn", "settings.json") };
}

function telemetryFor(cwd: string, env: Record<string, string | undefined> = {}) {
  return resolveTelemetry(resolveSettings({ cwd, env, home }), env);
}

test("a megabyte is 1,048,576 bytes and the cap defaults to 1024 of them", () => {
  expect(BYTES_PER_MEGABYTE).toBe(1024 * 1024);
  expect(DEFAULT_TELEMETRY_MAX_MEGABYTES).toBe(1024);
});

test("without settings telemetry is local, and only DO_NOT_TRACK=1 turns it off", () => {
  const { cwd } = telemetryProject();
  const local = { mode: "local", source: "default", settingsPath: null, maxMegabytes: 1024 } as const;

  expect(telemetryFor(cwd)).toEqual(local);
  for (const value of ["true", "0", "", "yes", " 1", "1 "]) {
    expect(telemetryFor(cwd, { DO_NOT_TRACK: value })).toEqual(local);
  }
  expect(telemetryFor(cwd, { DO_NOT_TRACK: "1" })).toEqual({ mode: "off", source: "DO_NOT_TRACK", settingsPath: null, maxMegabytes: 1024 });
});

test("a telemetry.mode in a settings file wins over DO_NOT_TRACK in both directions", () => {
  const { cwd, globalPath } = telemetryProject();

  globalFile({ telemetry: { mode: "off" } });
  expect(telemetryFor(cwd)).toEqual({ mode: "off", source: "settings", settingsPath: globalPath, maxMegabytes: 1024 });

  globalFile({ telemetry: { mode: "local" } });
  expect(telemetryFor(cwd, { DO_NOT_TRACK: "1" })).toEqual({ mode: "local", source: "settings", settingsPath: globalPath, maxMegabytes: 1024 });
});

test("zinn.local.json decides the mode over the global file, and a file that sets only the cap leaves it alone", () => {
  const { cwd, localPath, globalPath } = telemetryProject();
  globalFile({ telemetry: { mode: "off" } });
  writeJson(localPath, { telemetry: { mode: "local" } });

  expect(telemetryFor(cwd, { DO_NOT_TRACK: "1" })).toMatchObject({ mode: "local", source: "settings", settingsPath: localPath });

  writeJson(localPath, { telemetry: { maxMegabytes: 5 } });

  expect(telemetryFor(cwd)).toEqual({ mode: "off", source: "settings", settingsPath: globalPath, maxMegabytes: 5 });

  globalFile({});

  expect(telemetryFor(cwd, { DO_NOT_TRACK: "1" })).toEqual({ mode: "off", source: "DO_NOT_TRACK", settingsPath: null, maxMegabytes: 5 });
  expect(telemetryFor(cwd)).toEqual({ mode: "local", source: "default", settingsPath: null, maxMegabytes: 5 });
});

test("each file may set one telemetry field and the merged settings carry both", () => {
  const { cwd, localPath, globalPath } = telemetryProject();
  globalFile({ telemetry: { mode: "off" } });
  writeJson(localPath, { telemetry: { maxMegabytes: 7 } });

  expect(resolveSettings({ cwd, env: {}, home }).merged).toEqual({ telemetry: { mode: "off", maxMegabytes: 7 } });
  expect(telemetryFor(cwd)).toEqual({ mode: "off", source: "settings", settingsPath: globalPath, maxMegabytes: 7 });
});

test("with ZINN_DIR only that directory's settings.json sets telemetry", () => {
  const { cwd, localPath } = telemetryProject();
  const zinnDirectory = join(root, "selected");
  globalFile({ telemetry: { mode: "off" } });
  writeJson(localPath, { telemetry: { mode: "off" } });
  writeJson(join(zinnDirectory, "settings.json"), { telemetry: { maxMegabytes: 3 } });

  expect(telemetryFor(cwd, { ZINN_DIR: zinnDirectory })).toEqual({ mode: "local", source: "default", settingsPath: null, maxMegabytes: 3 });
});

test("a telemetry value Zinn does not accept is a settings error naming the file", () => {
  const { cwd, localPath } = telemetryProject();
  const rejected = [{ maxMegabytes: "1G" }, { maxMegabytes: 0 }, { maxMegabytes: -1 }, { maxMegabytes: 1.5 }, { maxMegabytes: null }, { mode: "on" }, { mode: "Local" }, { enabled: true }];

  for (const telemetry of rejected) {
    writeJson(localPath, { telemetry });

    expect(() => resolveSettings({ cwd, env: {}, home })).toThrow(expect.objectContaining({ message: expect.stringContaining(localPath), kind: "input" }));
  }
});
