// Runs every check of the Claude Code plugins in integrations/claude-code/.
//
//   bun run claude-code:check                    every plugin the marketplace lists
//   bun run claude-code:check zinn               one plugin
//   bun run claude-code:check --types FILE       type-check against this declaration file
//   bun run claude-code:check --skip-test        leave out `claude plugin test`
//
// Per plugin: the manifest parses and a `const VERSION` in hooks/ equals its version. Nothing under lib/
// imports the engine. `claude plugin validate`. `claude plugin test` (a stubbed engine, no model, no store).
// and tsc against the running engine's declarations. Claude Code writes those declarations each time a
// session loads its plugin-authoring skill, so load that skill once after a Claude Code update, or pass
// --types. The `claude` binary must be on PATH. Writes nothing but a tsconfig in a temporary folder.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

type Outcome = "pass" | "fail" | "skip";
type Result = { plugin: string; check: string; outcome: Outcome; detail: string };

const repositoryDirectory = join(import.meta.dir, "..");
const integrationDirectory = join(repositoryDirectory, "integrations", "claude-code");
const typescriptCompiler = join(repositoryDirectory, "node_modules", ".bin", "tsc");
// `claude plugin test` runs every kit test of a plugin. The slowest plugin takes about ten seconds.
const testTimeoutMs = 15 * 60 * 1000;
const commandTimeoutMs = 3 * 60 * 1000;

// A real import only. A string literal that reads 'claude-code' is not one.
const engineImport =
  /^\s*(?:import|export)\b[^'"\n;]*\bfrom\s*['"]claude-code(?:\/[^'"]*)?['"]|^\s*import\s*['"]claude-code(?:\/[^'"]*)?['"]|\bimport\s*\(\s*['"]claude-code(?:\/[^'"]*)?['"]/m;
const versionConstant = /^const VERSION = ['"]([^'"]+)['"]/m;
const declarationStamp = /^\/\/ Written by Claude Code (\S+?)\.?$/;

// The compiler options the engine's declaration file recommends for a hooks module.
const compilerOptions = {
  target: "es2023",
  lib: ["es2023"],
  types: [],
  module: "esnext",
  moduleResolution: "bundler",
  strict: true,
  noUncheckedIndexedAccess: true,
  noEmit: true,
  skipLibCheck: true,
  jsx: "react",
  jsxFactory: "h",
  jsxFragmentFactory: "Fragment",
};

function run(argv: string[], timeout: number): { status: number; output: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (result.error !== undefined) {
    return { status: 127, output: `${argv[0]}: ${result.error.message}` };
  }
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .map((path) => join(directory, path))
    .filter((path) => statSync(path).isFile());
}

function installedVersion(): string | null {
  const { status, output } = run(["claude", "--version"], commandTimeoutMs);
  const match = /^\s*(\d+\.\d+\.\d+)/.exec(output);
  if (status !== 0 || match === null) {
    return null;
  }
  return match[1]!;
}

function stampOf(path: string): string | null {
  const firstLine = readFileSync(path, "utf8").split("\n", 1)[0]!.trim();
  return declarationStamp.exec(firstLine)?.[1] ?? null;
}

// The declaration file the running engine wrote for its plugin-authoring skill, newest first.
function engineDeclarations(version: string | null): string | null {
  if (version === null) {
    return null;
  }
  const candidates: string[] = [];
  for (const base of new Set([tmpdir(), "/tmp", "/private/tmp"])) {
    if (!existsSync(base)) {
      continue;
    }
    for (const userDirectory of readdirSync(base).filter((name) => name.startsWith("claude-"))) {
      const versionDirectory = join(base, userDirectory, "bundled-skills", version);
      if (!existsSync(versionDirectory)) {
        continue;
      }
      for (const hash of readdirSync(versionDirectory)) {
        const path = join(versionDirectory, hash, "plugin-authoring", "types", "claude-code.d.ts");
        if (existsSync(path)) {
          candidates.push(path);
        }
      }
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function marketplacePlugins(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(integrationDirectory, ".claude-plugin", "marketplace.json"), "utf8"),
  ) as { plugins: { name: string }[] };
  return manifest.plugins.map((plugin) => plugin.name);
}

function checkManifest(pluginDirectory: string): [Outcome, string] {
  let version: unknown;
  try {
    version = JSON.parse(
      readFileSync(join(pluginDirectory, ".claude-plugin", "plugin.json"), "utf8"),
    ).version;
  } catch (error) {
    return ["fail", `plugin.json: ${(error as Error).message}`];
  }
  for (const path of listFiles(join(pluginDirectory, "hooks"))) {
    const declared = versionConstant.exec(readFileSync(path, "utf8"))?.[1];
    if (declared !== undefined && declared !== version) {
      return [
        "fail",
        `${relative(pluginDirectory, path)} says VERSION ${declared}, plugin.json says ${String(version)}`,
      ];
    }
  }
  return ["pass", `version ${String(version)}`];
}

function checkPurity(pluginDirectory: string): [Outcome, string] {
  const libDirectory = join(pluginDirectory, "lib");
  const importing = listFiles(libDirectory)
    .filter((path) => /\.[cm]?tsx?$/.test(path) && engineImport.test(readFileSync(path, "utf8")))
    .map((path) => relative(pluginDirectory, path));
  if (importing.length > 0) {
    return ["fail", `imports the engine: ${importing.join(", ")}`];
  }
  return ["pass", "lib/ imports nothing from the engine"];
}

function checkValidate(pluginDirectory: string): [Outcome, string] {
  const { status, output } = run(
    ["claude", "plugin", "validate", pluginDirectory],
    commandTimeoutMs,
  );
  const lastLine = output.trim().split("\n").at(-1)?.trim() ?? "";
  return [status === 0 ? "pass" : "fail", lastLine || `exit ${status}`];
}

function checkTests(pluginDirectory: string): [Outcome, string] {
  const { status, output } = run(["claude", "plugin", "test", pluginDirectory], testTimeoutMs);
  const passed = /^\s*(\d+) pass/m.exec(output)?.[1] ?? "?";
  const failed = /^\s*(\d+) fail/m.exec(output)?.[1] ?? "?";
  const counts = `${passed} pass, ${failed} fail`;
  if (status !== 0) {
    const names = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+ms\])?$/gm)].map(
      (match) => match[1],
    );
    return [
      "fail",
      names.length > 0 ? `${counts}: ${names.join("; ")}` : `${counts}, exit ${status}`,
    ];
  }
  return ["pass", counts];
}

function checkTypes(
  pluginDirectory: string,
  declarations: string | null,
  scratch: string,
): [Outcome, string] {
  if (declarations === null) {
    return [
      "fail",
      "no declarations for the installed Claude Code: load the plugin-authoring skill in a session once, or pass --types",
    ];
  }
  const include = [
    declarations,
    ...["hooks", "lib", "types", "tests"].map((name) => join(pluginDirectory, name)),
  ];
  const project = join(scratch, `${relative(integrationDirectory, pluginDirectory)}.json`);
  writeFileSync(
    project,
    JSON.stringify({ compilerOptions, include: include.filter((path) => existsSync(path)) }),
  );
  const { status, output } = run([typescriptCompiler, "-p", project], commandTimeoutMs);
  const against = `against Claude Code ${stampOf(declarations) ?? "unknown"}`;
  if (status !== 0) {
    const errors = output.split("\n").filter((line) => line.includes("error TS"));
    return ["fail", `${against}: ${errors.length} error(s)\n${errors.join("\n")}`];
  }
  return ["pass", against];
}

function main(): number {
  const args = process.argv.slice(2);
  let skipTests = false;
  let typesFile: string | null = null;
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--skip-test") {
      skipTests = true;
    } else if (arg === "--types") {
      typesFile = args[index + 1] ?? "";
      index++;
    } else if (arg.startsWith("--")) {
      console.error(`unknown option: ${arg}`);
      return 2;
    } else {
      names.push(arg);
    }
  }
  const plugins = names.length > 0 ? names : marketplacePlugins();

  const unknown = plugins.filter(
    (name) => !existsSync(join(integrationDirectory, name, ".claude-plugin", "plugin.json")),
  );
  if (unknown.length > 0) {
    console.error(`not a plugin in integrations/claude-code: ${unknown.join(", ")}`);
    return 2;
  }
  if (typesFile !== null && !existsSync(typesFile)) {
    console.error(`--types: no such file: ${typesFile}`);
    return 2;
  }

  const installed = installedVersion();
  const declarations = typesFile ?? engineDeclarations(installed);
  console.log(`Claude Code ${installed ?? "not found"}, declarations: ${declarations ?? "none"}`);

  const results: Result[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "zinn-claude-code-check-"));
  try {
    for (const plugin of plugins) {
      const pluginDirectory = join(integrationDirectory, plugin);
      console.log(`\n${plugin}`);
      const checks: [string, () => [Outcome, string]][] = [
        ["manifest", () => checkManifest(pluginDirectory)],
        ["purity", () => checkPurity(pluginDirectory)],
        ["validate", () => checkValidate(pluginDirectory)],
        ["test", () => (skipTests ? ["skip", "--skip-test"] : checkTests(pluginDirectory))],
        ["tsc", () => checkTypes(pluginDirectory, declarations, scratch)],
      ];
      for (const [check, perform] of checks) {
        const [outcome, detail] = perform();
        results.push({ plugin, check, outcome, detail });
        console.log(`  ${check.padEnd(9)} ${outcome.padEnd(5)} ${detail}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const failed = results.filter((result) => result.outcome === "fail");
  console.log(`\n${results.length - failed.length} passed or skipped, ${failed.length} failed`);
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = main();
