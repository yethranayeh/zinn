import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir } from "../test-helpers";

type Hooks = Record<string, { command: string; timeout?: number }>;
// Well under the 10-second sleep the slow hook starts, so waiting on it fails the check.
const HOOK_COMMAND_LIMIT_MS = 5_000;

function writeHooks(dir: string, hooks: Hooks) {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }));
}

function readLines(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : [];
}

/** A hook that appends its name, stdin, working folder and ZINN_HOOKS to files in `dir`, and prints to stdout. */
function recordingHook(dir: string, name: string) {
  const file = (suffix: string) => `'${join(dir, `${name}.${suffix}`)}'`;
  return {
    command: `cat >> ${file("stdin")}; pwd >> ${file("cwd")}; printf '%s\\n' "$ZINN_HOOKS" >> ${file("env")}; echo ${name} >> '${join(dir, "order")}'; echo ${name}-output`,
  };
}

function runZinnIn(args: Array<string>, dir: string, cwd: string, additionalEnv: Record<string, string> = {}) {
  return runProcessAsync([process.execPath, CLI_PATH, ...args], { env: { ...TEST_ENVIRONMENT, ...additionalEnv, ZINN_DIR: dir }, cwd });
}

test("ZINN-161: a CLI change runs each hook once in settings order, in the caller's folder, and keeps --json on stdout", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    writeHooks(dir, { second: recordingHook(dir, "second"), first: recordingHook(dir, "first") });
    const caller = join(dir, "caller");
    mkdirSync(caller);

    const result = await runZinnIn(["task", "create", "APP", "--title", "Hooked", "--json"], dir, caller);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).key).toBe("APP-1");
    expect(result.stdout).not.toContain("-output");
    expect(result.stderr).toContain("second-output");
    expect(result.stderr).toContain("first-output");
    expect(readLines(join(dir, "order"))).toEqual(["second", "first"]);
    expect(readLines(join(dir, "first.cwd"))).toEqual([realpathSync(caller)]);
    expect(readLines(join(dir, "first.env"))).toEqual(["0"]);

    const [record, ...rest] = readLines(join(dir, "first.stdin")).map((line) => JSON.parse(line));
    expect(rest).toEqual([]);
    const listed = JSON.parse((await runZinn(["activity", "list", "--limit", "1", "--json"], dir)).stdout);
    expect(record).toEqual({ ...listed[0], task_key: "APP-1" });
  });
});

test("ZINN-161: a failing or slow hook warns with its name, the change stays saved and zinn exits 0", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    // A compound command keeps the shell as the parent of sleep, so a timeout must end both
    writeHooks(dir, { failing: { command: "exit 3" }, slow: { command: "echo slow-started; sleep 10", timeout: 0.5 } });

    const started = Date.now();
    const result = await runZinn(["task", "create", "APP", "--title", "Saved", "--json"], dir);

    expect(Date.now() - started).toBeLessThan(HOOK_COMMAND_LIMIT_MS);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).key).toBe("APP-1");
    expect(result.stderr).toContain('"failing"');
    expect(result.stderr).toContain('"slow"');
    expect(JSON.parse((await runZinn(["task", "view", "APP-1", "--json"], dir)).stdout).title).toBe("Saved");
  });
});

test("ZINN-161: a hook's own zinn writes run no hooks, and ZINN_HOOKS=0 runs none", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "APP"], dir);
    const runs = join(dir, "runs");
    writeHooks(dir, {
      writing: { command: `echo run >> '${runs}'; '${process.execPath}' '${CLI_PATH}' task create APP --title Inner > /dev/null` },
    });

    expect((await runZinn(["task", "create", "APP", "--title", "Outer"], dir)).code).toBe(0);
    expect(readLines(runs)).toEqual(["run"]);
    const titles = JSON.parse((await runZinn(["task", "list", "APP", "--json"], dir, { ZINN_HOOKS: "0" })).stdout).map((item: { title: string }) => item.title);
    expect(titles.sort()).toEqual(["Inner", "Outer"]);

    expect((await runZinn(["task", "create", "APP", "--title", "Quiet"], dir, { ZINN_HOOKS: "0" })).code).toBe(0);
    expect(readLines(runs)).toEqual(["run"]);
  });
});

test("ZINN-161: hooks in zinn.local.json fail the command as a settings error and never run", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = join(dir, "repository");
    const home = join(dir, "home");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(home);
    const marker = join(dir, "ran");
    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ hooks: { local: { command: `touch '${marker}'` } } }));
    const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: home };
    delete env.ZINN_DIR;

    const result = await runProcessAsync([process.execPath, CLI_PATH, "project", "create", "APP", "--json"], { env, cwd: repository });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({
      details: { reason: "invalid_settings", field: ["hooks"], settingsPath: join(realpathSync(repository), "zinn.local.json") },
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(home, ".zinn"))).toBe(false);
  });
});
