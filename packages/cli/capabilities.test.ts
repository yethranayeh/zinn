import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { generateCapabilities } from "./src/capabilities";
import { parseRoutes } from "./src/routes/router";
import { routes } from "./src/routes/routes";
import { runCli } from "./testing";
import { capabilityValidator, checkCapabilityConsumer, checkCapabilityDiscovery, inventory } from "./capability-checks";

const root = mkdtempSync(join(tmpdir(), "zinn-capabilities-"));
const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const entryPoint = join(packageDirectory, "index.ts");
const manifest = generateCapabilities();
const env = { ...process.env, ZINN_DEBUG: undefined, DEBUG: undefined, FORCE_COLOR: "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the emitted contract covers every route and finite result, including itself", () => {
  const actual = checkCapabilityDiscovery({
    runtime: process.execPath, entryPoint, packageDirectory,
    directory: join(root, "discovery"), env, expected: manifest,
  });
  expect(actual.commands).toEqual(parseRoutes(routes).map(({ command, summary, input, effects, confirmation, results }) => ({
    path: command.split(" "), summary, input, effects, confirmation, results,
  })));
  const validate = capabilityValidator(actual).getSchema("results#/definitions/Capabilities")!;
  expect(validate({ ...actual, manifestVersion: 2 })).toBe(false);
  expect(validate({ ...actual, commands: [{ ...actual.commands[0], run: "implementation" }] })).toBe(false);
  const { error, ...missing } = actual;
  expect(validate(missing)).toBe(false);
});

test("discovery is deterministic across settings, stores, cwd, locale and debug environments", () => {
  const directory = join(root, "environments");
  const home = join(directory, "home");
  const codebase = join(directory, "codebase");
  const blocked = join(directory, "blocked");
  mkdirSync(join(home, ".zinn"), { recursive: true });
  mkdirSync(join(codebase, ".git"), { recursive: true });
  mkdirSync(blocked);
  writeFileSync(join(home, ".zinn/settings.json"), "{");
  writeFileSync(join(codebase, "zinn.local.json"), "{");
  const invalidStore = join(directory, "invalid-store");
  mkdirSync(invalidStore);
  writeFileSync(join(invalidStore, "settings.json"), "{");
  chmodSync(blocked, 0o500);
  try {
    const before = inventory(directory);
    for (const [index, store] of [undefined, join(directory, "missing"), invalidStore, blocked, "/dev/null/unavailable"].entries()) {
      const result = runCli(["--json", "capabilities"], {
        cwd: index % 2 === 0 ? codebase : home,
        env: { ...env, HOME: home, ZINN_DIR: store, LANG: index % 2 === 0 ? "tr_TR.UTF-8" : "C", LC_ALL: index % 2 === 0 ? "tr_TR.UTF-8" : "C", ZINN_DEBUG: "1", DEBUG: "1", AI_AGENT: `user-${index}`, FORCE_COLOR: "1" },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(manifest);
    }
    expect(inventory(directory)).toEqual(before);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("discovery bypasses settings, storage policy, SQLite and Bun process APIs", () => {
  const directory = join(root, "intercepted");
  mkdirSync(directory);
  const preload = join(directory, "guard.ts");
  const coreSource = fileURLToPath(new URL("../core/src/", import.meta.url));
  writeFileSync(preload, `
    import { mock } from "bun:test";
    const { settingsFileSourceSchema, settingsFileStateSchema } = await import(${JSON.stringify(join(coreSource, "settings.ts"))});
    const forbidden = () => { throw new Error("Forbidden discovery access"); };
    mock.module(${JSON.stringify(join(coreSource, "db.ts"))}, () => ({ configureDatabase: forbidden, assertWritable: forbidden, getDb: forbidden, writeTransaction: forbidden, closeDb: forbidden }));
    mock.module(${JSON.stringify(join(coreSource, "settings.ts"))}, () => ({ settingsFileSourceSchema, settingsFileStateSchema, resolveSettings: forbidden, chooseDefaultProject: forbidden, inspectSettings: forbidden }));
    mock.module("bun:sqlite", () => ({ Database: class { constructor() { forbidden(); } } }));
    Bun.spawn = Bun.spawnSync = Bun.connect = forbidden;
  `);
  const before = inventory(directory);
  const result = Bun.spawnSync([process.execPath, "--preload", preload, entryPoint, "capabilities", "--json"], {
    cwd: directory, env: { ...env, HOME: directory, ZINN_DIR: join(directory, "forbidden-store") },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(manifest);
  expect(inventory(directory)).toEqual(before);
  const normalCommand = Bun.spawnSync([process.execPath, "--preload", preload, entryPoint, "task", "list", "--json"], {
    cwd: directory, env: { ...env, HOME: directory, ZINN_DIR: join(directory, "forbidden-store") },
  });
  expect(normalCommand.exitCode).toBe(1);
  expect(JSON.parse(normalCommand.stderr.toString()).error.code).toBe("internal");
});

test("a manifest consumer constructs argv and validates list, history, cardinality and order forms", () => {
  const directory = join(root, "consumer");
  mkdirSync(directory);
  const result = runCli(["capabilities", "--json"], { cwd: directory, env: { ...env, ZINN_DIR: join(directory, "store") } });
  expect(result.code, result.stderr).toBe(0);
  checkCapabilityConsumer(JSON.parse(result.stdout), (args) => runCli(args, {
    cwd: directory, env: { ...env, ZINN_DIR: join(directory, "store") },
  }));
}, 15000);

test("text summary, help precedence and invalid invocations preserve the CLI contract", () => {
  const directory = join(root, "invocations");
  mkdirSync(directory);
  const options = { cwd: directory, env: { ...env, ZINN_DIR: "/dev/null/unavailable" } };
  const text = runCli(["capabilities"], options);
  expect(text.code, text.stderr).toBe(0);
  expect(text.stdout).toContain(manifest.cli.name);
  expect(text.stdout).toContain(manifest.cli.version);
  expect(text.stdout).toContain("zinn capabilities --json");
  const help = runCli(["capabilities", "--help", "--json", "--unknown"], options);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain("Usage:");
  for (const args of [["extra"], ["--unknown"], ["--json"], ["--", "--json"]]) {
    const result = runCli(["capabilities", "--json", ...args], options);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
  }
});
