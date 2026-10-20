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
import { commandAliases } from "./src/routes/aliases";

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
  const commands = new Map(actual.commands.map((command) => [command.path.join(" "), command]));
  expect(commands.size).toBe(actual.commands.length);
  expect(commands.size).toBe(parseRoutes(routes).length);
  const activityInput = commands.get("activity list")!.input;
  expect(activityInput.options["task-id"]).toMatchObject({ type: "string", value: { kind: "task-id" } });
  expect(activityInput.options["show-deleted"]).toMatchObject({ type: "boolean" });
  expect(activityInput.options["project-id"]).toMatchObject({ type: "string", value: { kind: "project-id" } });
  expect(activityInput.options.project).toMatchObject({ type: "string", value: { kind: "project-key" } });
  expect(activityInput.constraints).toContainEqual({ kind: "exclusive", members: ["option:project", "option:project-id", "option:task", "option:task-id"] });
  expect(activityInput.constraints).toContainEqual({ kind: "requiresAny", input: "option:show-deleted", members: ["option:project", "option:task"] });
  const validator = capabilityValidator(actual);
  for (const route of parseRoutes(routes)) {
    const command = commands.get(route.command);
    expect(command).toBeDefined();
    const words = route.command.split(" ");
    const name = words.pop()!;
    expect(command!.aliases).toEqual((commandAliases[name] ?? []).map((alias) => [...words, alias]));
    if (command!.aliases.length === 0) {
      expect(route.help).not.toMatch(/^Alias:/m);
    }
    expect(command!.results.length).toBeGreaterThan(0);
    for (const result of command!.results) {
      expect(validator.getSchema(`results#${result.schemaRef.slice("#/schemas".length)}`)).toBeDefined();
    }
  }
  const validate = validator.getSchema("results#/definitions/Capabilities")!;
  expect(validate({ ...actual, manifestVersion: 2 })).toBe(false);
  const canonicalArgv = actual.invocation.canonicalArgv;
  expect(validate({ ...actual, invocation: { ...actual.invocation, canonicalArgv: [...canonicalArgv].reverse() } })).toBe(false);
  expect(validate({ ...actual, invocation: { ...actual.invocation, canonicalArgv: canonicalArgv.map(() => canonicalArgv[0]) } })).toBe(false);
  expect(validate({ ...actual, commands: [{ ...actual.commands[0], run: "implementation" }] })).toBe(false);
  const { error, ...missing } = actual;
  expect(validate(missing)).toBe(false);
}, 15000);

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
  mkdirSync(join(directory, "store"));
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
  const debug = runCli(["capabilities", "--json"], {
    ...options, env: { ...options.env, ZINN_DEBUG: "1" },
  });
  expect(debug.code, debug.stderr).toBe(0);
  const parsedGroups = debug.stderr.split("\n").filter((line) => line.startsWith("::router.parseRoutes["));
  expect(parsedGroups.length).toBeGreaterThan(0);
  expect(new Set(parsedGroups).size).toBe(parsedGroups.length);
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

test("text discovery does not generate result schemas", () => {
  const directory = join(root, "summary");
  mkdirSync(directory);
  const preload = join(directory, "guard.ts");
  const schemas = fileURLToPath(new URL("./src/result-schemas.ts", import.meta.url));
  writeFileSync(preload, `
    import { mock } from "bun:test";
    const schemas = await import(${JSON.stringify(schemas)});
    mock.module(${JSON.stringify(schemas)}, () => ({
      ...schemas,
      generateResultSchemas() { throw new Error("Unexpected schema generation"); },
    }));
  `);
  const invoke = (args: string[]) => Bun.spawnSync([process.execPath, "--preload", preload, entryPoint, "capabilities", ...args], {
    cwd: directory, env: { ...env, ZINN_DIR: join(directory, "store") },
  });
  const text = invoke([]);
  expect(text.exitCode, text.stderr.toString()).toBe(0);
  expect(text.stdout.toString()).toContain(manifest.cli.name);
  const json = invoke(["--json"]);
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stderr.toString()).error.code).toBe("internal");
});
