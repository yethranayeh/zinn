import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import packageJson from "./package.json";
import { runCli, runCliInTerminal } from "./testing";
import { withDirectory } from "../core/src/migrations/testing";
import { errorDocumentSchema } from "./src/errors";
import { readNodeMinimum } from "../../scripts/package-fixture.ts";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const outputDirectory = join(packageDirectory, "dist");
const coreOutputDirectory = fileURLToPath(new URL("../core/dist", import.meta.url));
const CLI_PATH = join(outputDirectory, "index.js");
const BUILD_CHECK_TIMEOUT_MS = 30_000;
const LARGER_THAN_PIPE_BUFFER = 200_000;
// Well under the 10-second sleeps the hooks below start, so waiting on either fails the check.
const HOOK_COMMAND_LIMIT_MS = 5_000;

function runBuilt(runtime: string, args: string[], directory: string, env: Record<string, string> = {}) {
  return runCli(args, { runtime, cliPath: CLI_PATH, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, ...env } });
}

beforeAll(() => {
  const minimum = readNodeMinimum(repositoryDirectory);
  const node = Bun.spawnSync(["node", "--version"], { env: TEST_ENVIRONMENT });
  const version = node.stdout.toString().trim();
  if (node.exitCode !== 0 || !Bun.semver.satisfies(version, `>=${minimum.version}`)) {
    throw new Error(`CLI build tests require Node.js >=${minimum.version} on PATH; found ${version || "no usable Node.js"}.`);
  }

  // A development build refreshes both outputs, including old release identity.
  for (const directory of [outputDirectory, coreOutputDirectory]) {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src/release-identity.js"), 'export const RELEASE_MODE = "published";');
  }

  const result = Bun.spawnSync(["bun", "run", "--cwd", packageDirectory, "build"], { env: TEST_ENVIRONMENT });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  for (const directory of [outputDirectory, coreOutputDirectory]) {
    const identityUrl = pathToFileURL(join(directory, "src/release-identity.js")).href;
    const identity = Bun.spawnSync(["bun", "--eval", `console.log((await import(${JSON.stringify(identityUrl)})).RELEASE_MODE)`], { env: TEST_ENVIRONMENT });
    expect(identity.exitCode, identity.stderr.toString()).toBe(0);
    expect(identity.stdout.toString().trim()).toBe("source");
  }
}, BUILD_CHECK_TIMEOUT_MS);

for (const runtime of ["node", "bun"]) {
  test(`${runtime}: built whoami reports declared identity without creating storage`, () => {
    withDirectory((directory) => {
      const declarations = { CODEX_SESSION_ID: "session", CODEX_THREAD_ID: "thread", ZINN_MODEL: "model" };
      const result = runBuilt(runtime, ["whoami", "--json"], directory, declarations);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        actor_name: "codex", actor_email: null, actor_kind: "agent", actor_source: "env:CODEX_THREAD_ID",
        actor_session_id: "session", actor_thread_id: "thread", actor_agent: null, actor_model: "model", actor_effort: null,
      });
      const text = runBuilt(runtime, ["whoami"], directory, declarations);
      expect(text.code).toBe(0);
      expect(text.stderr).toBe("");
      for (const fact of ["codex", "env:CODEX_THREAD_ID", "session", "thread", "model"]) {
        expect(text.stdout).toContain(fact);
      }
      expect(readdirSync(directory)).toEqual([]);
    });
  });

  test(`${runtime}: built project activity selectors preserve deleted identities and full records`, () => {
    withDirectory((directory) => {
      const run = (args: string[]) => {
        const result = runBuilt(runtime, args, directory, { NODE_NO_WARNINGS: "1" });
        expect(result.code, result.stderr).toBe(0);
        if (args.includes("--limit")) {
          expect(result.stderr).toContain("--starting-after");
        } else {
          expect(result.stderr).toBe("");
        }
        return JSON.parse(result.stdout);
      };
      run(["project", "create", "APP", "--json"]);
      const projectId = run(["activity", "list", "--json"])[0].entity_id;
      run(["task", "create", "APP", "--title", "Original", "--json"]);
      const first = run(["activity", "list", "--project", "APP", "--json"]);
      expect(first).toEqual(run(["activity", "list", "--json"]));
      run(["project", "delete", "APP", "--yes", "--json"]);
      const deleted = run(["activity", "list", "--project-id", projectId.replaceAll("-", "").toUpperCase(), "--json"]);
      expect(deleted.slice(1)).toEqual(first);
      expect(deleted[0]).toMatchObject({ entity_type: "project", entity_id: projectId, action: "delete" });
      run(["project", "create", "APP", "--json"]);
      expect(run(["activity", "list", "--project", "APP", "--json"])).toHaveLength(1);
      expect(run(["activity", "list", "--project", "APP", "--show-deleted", "--json"])).toEqual(run(["activity", "list", "--json"]));
      expect(run(["activity", "list", "--project-id", projectId, "--limit", "1", "--json"])).toEqual([deleted[0]]);
    });
  });

  test(`${runtime}: ZINN-161: built hooks get the change, warn on failure and never hold up the command`, () => {
    withDirectory((directory) => {
      const recorded = join(directory, "recorded.ndjson");
      writeFileSync(join(directory, "settings.json"), JSON.stringify({
        hooks: {
          recording: { command: `cat > '${recorded}'` },
          ignoring: { command: "exit 0" },
          detaching: { command: "sleep 10 >/dev/null 2>&1 &" },
          failing: { command: "echo hook-output; exit 3" },
          // A compound command keeps the shell as the parent of sleep, so a timeout must end both
          slow: { command: "echo slow-started; sleep 10", timeout: 0.5 },
        },
      }));
      expect(runBuilt(runtime, ["project", "create", "APP"], directory).code).toBe(0);

      const started = Date.now();
      const result = runBuilt(runtime, ["task", "create", "APP", "--title", "Large", "--description", "x".repeat(LARGER_THAN_PIPE_BUFFER), "--json"], directory, { NODE_NO_WARNINGS: "1" });
      expect(Date.now() - started).toBeLessThan(HOOK_COMMAND_LIMIT_MS);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).key).toBe("APP-1");
      for (const name of ["failing", "slow"]) {
        expect(result.stderr).toContain(`"${name}"`);
      }
      for (const name of ["recording", "ignoring", "detaching"]) {
        expect(result.stderr).not.toContain(`"${name}"`);
      }
      expect(result.stderr).toContain("hook-output");
      expect(result.stdout).not.toContain("hook-output");
      const lines = readFileSync(recorded, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([expect.objectContaining({ entity_type: "task", action: "create", task_key: "APP-1" })]);
    });
  });

  test(`${runtime}: explicit store refusals leave files unchanged across reads, writes and administration`, () => {
    withDirectory((temporaryDirectory) => {
      const directory = realpathSync(temporaryDirectory);
      const origin = join(directory, "origin");
      mkdirSync(origin);
      expect(runBuilt(runtime, ["project", "create", "BACKUP"], origin).code).toBe(0);
      const saved = runBuilt(runtime, ["backup", "--json"], origin);
      expect(saved.code).toBe(0);
      const backupPath = JSON.parse(saved.stdout).path;
      const commands = [
        ["project", "list"],
        ["project", "create", "REFUSED"],
        ["backup"],
        ["migrate"],
        ["restore", backupPath, "--yes"],
      ];
      const cases = [
        { source: "env", state: "missing" },
        { source: "env", state: "file" },
        { source: "local", state: "missing" },
        { source: "local", state: "file" },
        { source: "global", state: "missing" },
        { source: "global", state: "file" },
        { source: "env", state: "empty" },
        { source: "env", state: "relative" },
      ];

      for (const { source, state } of cases) {
        const cwd = join(directory, `${source}-${state}`);
        const home = join(cwd, "home");
        mkdirSync(home, { recursive: true });
        const selected = state === "empty" ? cwd : join(cwd, "store with ' quote");
        const env: Record<string, string | undefined> = {
          ...TEST_ENVIRONMENT, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        };
        delete env.ZINN_DIR;
        let chosenBy = "ZINN_DIR";
        if (source === "env") {
          env.ZINN_DIR = state === "empty" ? "" : state === "relative" ? "store with ' quote" : selected;
        } else {
          chosenBy = source === "local"
            ? join(cwd, "zinn.local.json")
            : join(home, ".zinn", "settings.json");
          mkdirSync(join(home, ".zinn"));
          writeFileSync(chosenBy, JSON.stringify({ storage: { directory: selected } }));
        }
        if (state === "file") {
          writeFileSync(selected, "Existing file\n");
        }
        const snapshot = () => Object.fromEntries(
          readdirSync(cwd, { recursive: true }).map((entry) => {
            const path = join(cwd, String(entry));
            return [String(entry), statSync(path).isDirectory() ? null : readFileSync(path, "utf8")];
          }),
        );
        const before = snapshot();

        for (const args of commands) {
          for (const flags of [[], ["--json"]]) {
            const result = runCli([...args, ...flags], { runtime, cliPath: CLI_PATH, cwd, env });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe("");
            const message = flags.length === 0
              ? result.stderr
              : errorDocumentSchema.parse(JSON.parse(result.stderr)).error.message;
            expect(message).toContain(selected);
            expect(message).toContain(chosenBy);
            expect(message).toContain("mkdir -p");
            if (flags.length > 0) {
              expect(JSON.parse(result.stderr).error).toMatchObject({
                code: "storage",
                details: { reason: "invalid_storage", path: selected },
              });
            }
          }
        }

        for (const args of [["--version"], ["--help"], ["task", "--help"], ["info", "--json"], ["whoami", "--json"]]) {
          const result = runCli(args, { runtime, cliPath: CLI_PATH, cwd, env });
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          if (args[0] === "info" && state !== "empty") {
            expect(JSON.parse(result.stdout).storage.exists).toBe(false);
          }
        }
        expect(snapshot()).toEqual(before);
      }
    });
  }, BUILD_CHECK_TIMEOUT_MS);

  test(`${runtime}: existing empty folders and the default store initialize, and restore creates data inside an existing folder`, () => {
    withDirectory((directory) => {
      const empty = join(directory, "empty");
      mkdirSync(empty);
      const listed = runBuilt(runtime, ["project", "list", "--json"], empty);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual([]);
      expect(existsSync(join(empty, "data", "zinn.sqlite"))).toBe(true);
      expect(runBuilt(runtime, ["project", "create", "RESTORED"], empty).code).toBe(0);
      const saved = runBuilt(runtime, ["backup", "--json"], empty);
      expect(saved.code).toBe(0);
      const destination = join(directory, "destination");
      mkdirSync(destination);
      const restored = runBuilt(runtime, ["restore", JSON.parse(saved.stdout).path, "--yes", "--json"], destination);
      expect(restored.code).toBe(0);
      expect(existsSync(join(destination, "data", "zinn.sqlite"))).toBe(true);
      expect(JSON.parse(runBuilt(runtime, ["project", "list", "--json"], destination).stdout)[0].key).toBe("RESTORED");

      const home = join(directory, "home");
      mkdirSync(home);
      const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: home };
      delete env.ZINN_DIR;
      const created = runCli(["project", "create", "DEFAULT", "--json"], { runtime, cliPath: CLI_PATH, cwd: home, env });
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout).key).toBe("DEFAULT");
      expect(existsSync(join(home, ".zinn", "data", "zinn.sqlite"))).toBe(true);
    });
  });

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
    const result = Bun.spawnSync([runtime, "--eval", code], { env: TEST_ENVIRONMENT });
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
      const created = runBuilt(runtime, ["task", "create", "BUILD", "--title", "Built CLI", "--due", "2026-10-25T12:34:56.123Z", "--json"], directory);
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ key: "BUILD-1", title: "Built CLI", due_at: 1_792_931_696_123 });
      const due = runBuilt(runtime, ["task", "list", "BUILD", "--due-since", "2026-10-25T13:34:56.123+01:00", "--due-until", "1792931696123", "--sort", "due", "--json"], directory);
      expect(due.code, due.stderr).toBe(0);
      expect(JSON.parse(due.stdout).map((row: { key: string }) => row.key)).toEqual(["BUILD-1"]);
      const dueText = runBuilt(runtime, ["task", "view", "BUILD-1"], directory, { TZ: "UTC" });
      expect(dueText.stdout).toContain("2026-10-25 12:34:56.123 +00:00");
      const edited = runBuilt(runtime, ["task", "edit", "BUILD-1", "--description", "Searchable output", "--json"], directory);
      expect(edited.code).toBe(0);
      expect(JSON.parse(edited.stdout).description).toBe("Searchable output");
      const descriptionEvents = runBuilt(runtime, ["activity", "list", "--action", "edit", "--changed", "description", "--json"], directory);
      expect(descriptionEvents.code).toBe(0);
      expect(descriptionEvents.stderr).toBe("");
      expect(JSON.parse(descriptionEvents.stdout)).toEqual([expect.objectContaining({
        entity_id: JSON.parse(created.stdout).id,
        action: "edit",
        changes: { description: [null, "Searchable output"] },
      })]);
      const initialTitle = runBuilt(runtime, ["activity", "list", "--action", "create", "--action", "edit", "--changed", "title", "--limit", "1", "--json"], directory);
      expect(initialTitle.code).toBe(0);
      expect(JSON.parse(initialTitle.stdout)).toEqual([expect.objectContaining({
        entity_id: JSON.parse(created.stdout).id,
        action: "create",
      })]);
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
      const options = { runtime, cliPath: CLI_PATH, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory }, stderrPath };
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
      const result = Bun.spawnSync([runtime, "--eval", code], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(JSON.parse(result.stderr.toString()).error.message).toContain("async build failure");
    });
  });
}

test("the emitted bin runs directly with its Node shebang", () => {
  withDirectory((directory) => {
    const result = Bun.spawnSync([CLI_PATH, "--version"], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
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
    const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: home };
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
    env: TEST_ENVIRONMENT,
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
      builtCli: builtCli.getCliOpenPolicy().release, sourceCli: sourceCli.getCliOpenPolicy().release,
      builtCore: builtCore.readCoreReleaseMode(), sourceCore: sourceCore.readCoreReleaseMode()
    })));`;
    const readIdentities = () => {
      const result = Bun.spawnSync(["bun", "--eval", code], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
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
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory },
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
