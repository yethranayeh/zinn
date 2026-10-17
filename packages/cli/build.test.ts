import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import packageJson from "./package.json";
import { runCli, runCliInTerminal } from "./testing";
import { withDirectory } from "../core/src/migrations/testing";
import { errorDocumentSchema } from "./src/errors";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const outputDirectory = join(packageDirectory, "dist");
const coreOutputDirectory = fileURLToPath(new URL("../core/dist", import.meta.url));
const CLI_PATH = join(outputDirectory, "index.js");
const BUILD_CHECK_TIMEOUT_MS = 30_000;

function runBuilt(runtime: string, args: string[], directory: string, env: Record<string, string> = {}) {
  return runCli(args, { runtime, cliPath: CLI_PATH, env: { ...process.env, ZINN_DIR: directory, ...env } });
}

beforeAll(() => {
  // A development build refreshes both outputs, including old release identity.
  for (const directory of [outputDirectory, coreOutputDirectory]) {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src/release-identity.js"), 'export const RELEASE_MODE = "published";');
  }

  const result = Bun.spawnSync(["bun", "run", "--cwd", packageDirectory, "build"]);
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  for (const directory of [outputDirectory, coreOutputDirectory]) {
    const identityUrl = pathToFileURL(join(directory, "src/release-identity.js")).href;
    const identity = Bun.spawnSync(["bun", "--eval", `console.log((await import(${JSON.stringify(identityUrl)})).RELEASE_MODE)`]);
    expect(identity.exitCode, identity.stderr.toString()).toBe(0);
    expect(identity.stdout.toString().trim()).toBe("source");
  }
}, BUILD_CHECK_TIMEOUT_MS);

for (const runtime of ["node", "bun"]) {
  test(`${runtime}: large handled errors reach piped stderr completely`, () => {
    const libUrl = pathToFileURL(join(outputDirectory, "src/lib.js")).href;
    // Exceed pipe buffers so an immediate process.exit would truncate the JSON document.
    const DIAGNOSTIC_COUNT = 10_000;
    const code = `import(${JSON.stringify(libUrl)}).then(({ prepareOutput, diagnostic, renderFailure }) => {
      prepareOutput(["--json"]);
      for (let index = 0; index < ${DIAGNOSTIC_COUNT}; index++) {
        diagnostic("A notice repeated for a large failure document");
      }
      renderFailure(new Error("failure"));
    });`;
    const result = Bun.spawnSync([runtime, "--eval", code]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    const failure = errorDocumentSchema.parse(JSON.parse(result.stderr.toString())).error;
    expect(failure.code).toBe("internal");
    expect(failure.diagnostics).toHaveLength(DIAGNOSTIC_COUNT);
  });

  test(`${runtime}: built version/help and JSON task operations use isolated stores`, () => {
    withDirectory((directory) => {
      const version = runBuilt(runtime, ["--version"], directory);
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toBe(packageJson.version);
      expect(version.stderr).toBe("");
      const help = runBuilt(runtime, ["--help"], directory);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("project");
      expect(help.stdout).toContain("--json");
      expect(existsSync(join(directory, "data"))).toBe(false);

      const project = runBuilt(runtime, ["project", "create", "BUILD", "--json"], directory);
      expect(project.code).toBe(0);
      expect(JSON.parse(project.stdout).key).toBe("BUILD");
      const created = runBuilt(runtime, ["task", "create", "BUILD", "--title", "Built CLI", "--json"], directory);
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ key: "BUILD-1", title: "Built CLI" });
      const edited = runBuilt(runtime, ["task", "edit", "BUILD-1", "--description", "Searchable output", "--json"], directory);
      expect(edited.code).toBe(0);
      expect(JSON.parse(edited.stdout).description).toBe("Searchable output");
      const searched = runBuilt(runtime, ["task", "search", "Searchable", "--json"], directory, { FORCE_COLOR: "1" });
      expect(searched.code).toBe(0);
      expect(JSON.parse(searched.stdout)[0].key).toBe("BUILD-1");
      expect(searched.stdout).not.toContain("\x1b[");

      expect(runBuilt(runtime, ["label", "create", "build-label", "--color", "red"], directory).code).toBe(0);
      const colored = runBuilt(runtime, ["label", "list"], directory, { FORCE_COLOR: "1", NO_COLOR: "1" });
      expect(colored.code).toBe(0);
      expect(colored.stdout).toContain("\x1b[");
      const plain = runBuilt(runtime, ["label", "list"], directory, { FORCE_COLOR: "0" });
      expect(plain.code).toBe(0);
      expect(plain.stdout).not.toContain("\x1b[");
      expect(plain.stdout).toContain("red");

      const refused = runBuilt(runtime, ["task", "delete", "BUILD-1", "--json"], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr).error.message).toContain("--yes");
      const failed = runBuilt(runtime, ["task", "delete", "BUILD-99", "--yes", "--json"], directory);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(JSON.parse(failed.stderr).error.message).toContain("BUILD-99");
      const viewed = runBuilt(runtime, ["task", "view", "BUILD-1", "--json"], directory);
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout).key).toBe("BUILD-1");
    });
  });

  test(`${runtime}: built confirmations keep prompts on stderr and await answers`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "zinn-cli-build-terminal-"));

    try {
      expect(runBuilt(runtime, ["project", "create", "BUILD"], directory).code).toBe(0);
      expect(runBuilt(runtime, ["task", "create", "BUILD", "--title", "Confirmation"], directory).code).toBe(0);
      const stderrPath = join(directory, "prompt.stderr");
      const options = { runtime, cliPath: CLI_PATH, env: { ...process.env, ZINN_DIR: directory }, stderrPath };
      const declined = await runCliInTerminal(["task", "delete", "BUILD-1"], { ...options, input: "n\n" });
      expect(declined.code).toBe(0);
      expect(declined.output).not.toContain("[y/N]");
      expect(readFileSync(stderrPath, "utf8")).toContain("BUILD-1");
      expect(readFileSync(stderrPath, "utf8")).toContain("[y/N]");
      expect(runBuilt(runtime, ["task", "view", "BUILD-1", "--json"], directory).code).toBe(0);
      const interrupted = await runCliInTerminal(["task", "delete", "BUILD-1"], {
        runtime, cliPath: CLI_PATH, env: options.env, input: "\x03", inputWhen: "[y/N]",
      });
      expect(interrupted.code).toBe(130);
      expect(runBuilt(runtime, ["task", "view", "BUILD-1", "--json"], directory).code).toBe(0);
      const accepted = await runCliInTerminal(["task", "delete", "BUILD-1"], { ...options, input: "Y\n" });
      expect(accepted.code).toBe(0);
      expect(accepted.output).not.toContain("[y/N]");
      expect(runBuilt(runtime, ["task", "view", "BUILD-1", "--json"], directory).code).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${runtime}: the emitted router catches rejected async handlers`, () => {
    withDirectory((directory) => {
      const routerUrl = pathToFileURL(join(outputDirectory, "src/routes/router.js")).href;
      const code = `import(${JSON.stringify(routerUrl)}).then(async ({ createRouter }) => {
        const router = createRouter({ fail: { help: "Usage: zinn fail", async run() { throw new Error("async build failure"); } } });
        await router.route(["fail", "--json"]);
      });`;
      const result = Bun.spawnSync([runtime, "--eval", code], { env: { ...process.env, ZINN_DIR: directory } });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(JSON.parse(result.stderr.toString()).error.message).toContain("async build failure");
    });
  });
}

test("the emitted bin runs directly with its Node shebang", () => {
  withDirectory((directory) => {
    const result = Bun.spawnSync([CLI_PATH, "--version"], { env: { ...process.env, ZINN_DIR: directory } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageJson.version);
  });
});

test("the emitted bin ignores the run folder's bunfig.toml and .env", () => {
  // ? ZINN-136: environment variables come only from whatever launches zinn.
  withDirectory((directory) => {
    const home = join(directory, "home");
    const dotenvStore = join(directory, "dotenv-store");
    const preloadMarker = join(directory, "preload-ran");
    const runFolder = join(directory, "run");
    mkdirSync(home);
    mkdirSync(runFolder);
    writeFileSync(join(runFolder, "preload.js"), `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "");\n`);
    writeFileSync(join(runFolder, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    writeFileSync(join(runFolder, ".env"), `ZINN_DIR=${dotenvStore}\n`);

    // Node and Bun keep a variable the launching environment set, so ZINN_DIR must be unset for a loaded .env to show.
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete env.ZINN_DIR;
    const result = Bun.spawnSync([CLI_PATH, "project", "create", "BUILD", "--json"], { cwd: runFolder, env });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()).key).toBe("BUILD");
    expect(existsSync(join(home, ".zinn", "data", "zinn.sqlite"))).toBe(true);
    expect(existsSync(dotenvStore)).toBe(false);
    expect(existsSync(preloadMarker)).toBe(false);
  });
});

test("the CLI build checks against core declarations rather than source modules", () => {
  const result = Bun.spawnSync(["bunx", "--no-install", "tsc", "-p", join(packageDirectory, "tsconfig.build.json"), "--noEmit", "--listFiles"], {
    cwd: repositoryDirectory,
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("packages/core/dist/index.d.ts");
  expect(result.stdout.toString()).not.toContain("packages/core/index.ts");
  expect(result.stdout.toString()).not.toContain("packages/core/src/");
});

test("source entrypoints ignore leftover release output and development identities stay source", () => {
  withDirectory((directory) => {
    const policyUrl = pathToFileURL(join(outputDirectory, "src/database.js")).href;
    const sourcePolicyUrl = pathToFileURL(join(packageDirectory, "src/database.ts")).href;
    const coreReleaseUrl = pathToFileURL(join(coreOutputDirectory, "src/release.js")).href;
    const sourceCoreReleaseUrl = pathToFileURL(fileURLToPath(new URL("../core/src/release.ts", import.meta.url))).href;
    const code = `Promise.all([
      import(${JSON.stringify(policyUrl)}), import(${JSON.stringify(sourcePolicyUrl)}),
      import(${JSON.stringify(coreReleaseUrl)}), import(${JSON.stringify(sourceCoreReleaseUrl)})
    ]).then(([builtCli, sourceCli, builtCore, sourceCore]) => console.log(JSON.stringify({
      builtCli: builtCli.cliOpenPolicy().release, sourceCli: sourceCli.cliOpenPolicy().release,
      builtCore: builtCore.readCoreReleaseMode(), sourceCore: sourceCore.readCoreReleaseMode()
    })));`;
    const readIdentities = () => {
      const result = Bun.spawnSync(["bun", "--eval", code], { env: { ...process.env, ZINN_DIR: directory } });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(readIdentities()).toEqual({ builtCli: "source", sourceCli: "source", builtCore: "source", sourceCore: "source" });

    const manifests = [outputDirectory, coreOutputDirectory].map((directory) => ({
      directory,
      content: readFileSync(join(directory, "package.json"), "utf8"),
      identity: readFileSync(join(directory, "src/release-identity.js"), "utf8"),
    }));

    try {
      for (const { directory, content } of manifests) {
        writeFileSync(join(directory, "package.json"), JSON.stringify({ ...JSON.parse(content), version: "1.0.0" }));
        writeFileSync(join(directory, "src/release-identity.js"), 'export const RELEASE_MODE = "published";\n');
      }

      expect(readIdentities()).toEqual({ builtCli: "published", sourceCli: "source", builtCore: "published", sourceCore: "source" });
      const sourceVersion = Bun.spawnSync(["bun", join(packageDirectory, "index.ts"), "--version"], {
        env: { ...process.env, ZINN_DIR: directory },
      });
      expect(sourceVersion.exitCode).toBe(0);
      expect(sourceVersion.stdout.toString().trim()).toBe(packageJson.version);
    } finally {
      for (const { directory, content, identity } of manifests) {
        writeFileSync(join(directory, "package.json"), content);
        writeFileSync(join(directory, "src/release-identity.js"), identity);
      }
    }
  });
});
