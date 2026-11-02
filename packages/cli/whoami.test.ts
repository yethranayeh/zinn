import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { runCli } from "./testing.ts";
import type { PresentedActor } from "./src/result-schemas.ts";

let directory: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zinn-whoami-"));
  const home = join(directory, "home");
  mkdirSync(home);
  env = { ...TEST_ENVIRONMENT, HOME: home, USER: userInfo().username, LOGNAME: userInfo().username, GIT_CONFIG_GLOBAL: "/dev/null", FORCE_COLOR: "0" };
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function run(args: string[], declarations: Record<string, string> = {}, cwd = directory) {
  return await runCli(args, { cwd, env: { ...env, ...declarations } });
}

async function identify(declarations: Record<string, string> = {}, cwd = directory): Promise<PresentedActor> {
  const result = await run(["whoami", "--json"], declarations, cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("\x1b");
  return JSON.parse(result.stdout);
}

test("whoami resolves agent markers and paired declarations without creating storage", async () => {
  const cases: Array<{ env: Record<string, string>; actor: Partial<PresentedActor> }> = [
    { env: { OPENCODE: "1" }, actor: { actor_name: "opencode", actor_source: "env:OPENCODE" } },
    { env: { AGENT: "1" }, actor: { actor_name: null, actor_source: "env:AGENT" } },
    { env: { AI_AGENT: "named-agent", OPENCODE: "1" }, actor: { actor_name: "named-agent", actor_source: "env:AI_AGENT" } },
    { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-session" }, actor: { actor_name: "claude-code", actor_source: "env:CLAUDECODE", actor_session_id: "claude-session" } },
    { env: { CODEX_SESSION_ID: "codex-session", CODEX_THREAD_ID: "codex-thread" }, actor: { actor_name: "codex", actor_source: "env:CODEX_THREAD_ID", actor_session_id: "codex-session", actor_thread_id: "codex-thread" } },
    { env: { OPENCODE: "1", OPENCODE_SESSION_ID: "opencode-thread" }, actor: { actor_name: "opencode", actor_source: "env:OPENCODE", actor_thread_id: "opencode-thread" } },
    { env: { OPENCODE: "1", ZINN_SESSION_ID: " session ", ZINN_THREAD_ID: " thread ", ZINN_AGENT: " worker ", ZINN_MODEL: " model ", ZINN_EFFORT: " high " }, actor: { actor_name: "opencode", actor_source: "env:OPENCODE", actor_session_id: "session", actor_thread_id: "thread", actor_agent: "worker", actor_model: "model", actor_effort: "high" } },
    { env: { CODEX_THREAD_ID: "native-thread", ZINN_SESSION_ID: "declared-session", ZINN_MODEL: " " }, actor: { actor_name: "codex", actor_source: "env:CODEX_THREAD_ID", actor_session_id: "declared-session" } },
  ];

  for (const fixture of cases) {
    const declarations: Record<string, string> = fixture.env;
    const actor = await identify(declarations);
    expect(actor).toEqual({
      actor_name: null, actor_email: null, actor_kind: "agent", actor_source: null,
      actor_session_id: null, actor_thread_id: null, actor_agent: null, actor_model: null, actor_effort: null,
      ...fixture.actor,
    });
    const text = await run(["whoami"], declarations);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain(actor.actor_name ?? "unknown");
    for (const value of Object.values(actor)) {
      if (value !== null) {
        expect(text.stdout).toContain(value);
      }
    }
    expect(text.stdout).toContain("null");
    if (declarations.AI_AGENT === "named-agent") {
      expect(text.stdout).not.toContain("opencode");
    }
  }
  expect(readdirSync(directory)).toEqual(["home"]);
  expect(existsSync(join(env.HOME!, ".zinn"))).toBe(false);
});

test("whoami uses repository git identity from the current folder and falls back to the OS user", async () => {
  expect(await identify()).toEqual({
    actor_name: userInfo().username, actor_email: null, actor_kind: "human", actor_source: "os-user",
    actor_session_id: null, actor_thread_id: null, actor_agent: null, actor_model: null, actor_effort: null,
  });
  const globalConfig = join(directory, "gitconfig");
  writeFileSync(globalConfig, "[user]\nname = Global Human\nemail = global@example.com\n");
  env.GIT_CONFIG_GLOBAL = globalConfig;
  const repo = join(directory, "repo");
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, env, stdio: "pipe" });
  git(["init", repo]);
  git(["-C", repo, "config", "user.name", "Local Human"]);
  git(["-C", repo, "config", "user.email", "local@example.com"]);
  const nested = join(repo, "nested");
  mkdirSync(nested);
  expect(await identify({}, nested)).toMatchObject({ actor_name: "Local Human", actor_email: "local@example.com", actor_kind: "human", actor_source: "git-config" });
  const text = await run(["whoami"], {}, nested);
  for (const fact of ["Local Human", "local@example.com", "human", "git-config"]) {
    expect(text.stdout).toContain(fact);
  }
  expect(existsSync(join(env.HOME!, ".zinn"))).toBe(false);
});

test("whoami ignores missing stores, invalid settings and corrupt databases", async () => {
  const store = join(directory, "store");
  const declarations = { OPENCODE: "1", ZINN_DIR: store };
  const expected = await identify(declarations);
  expect(existsSync(store)).toBe(false);
  mkdirSync(join(store, "data"), { recursive: true });
  writeFileSync(join(store, "settings.json"), "{");
  writeFileSync(join(store, "data", "zinn.sqlite"), "not a database");
  writeFileSync(join(directory, "zinn.local.json"), "{");
  expect(await identify(declarations)).toEqual(expected);
  expect(readFileSync(join(store, "data", "zinn.sqlite"), "utf8")).toBe("not a database");
  expect(readdirSync(join(store, "data"))).toEqual(["zinn.sqlite"]);
  expect(await identify({ ...declarations, ZINN_DIR: "" })).toEqual(expected);
});

test("whoami actor keys and values match recorded activity and share its text presentation", async () => {
  const declarations = { OPENCODE: "1", ZINN_DIR: directory, ZINN_SESSION_ID: "session", ZINN_THREAD_ID: "thread", ZINN_AGENT: "worker", ZINN_MODEL: "model", ZINN_EFFORT: "high" };
  const actor = await identify(declarations);
  expect(existsSync(join(directory, "data"))).toBe(false);
  expect((await run(["project", "create", "APP"], declarations)).code).toBe(0);
  const activity = await run(["activity", "list", "--json"], declarations);
  const [event] = JSON.parse(activity.stdout);
  expect(Object.fromEntries(Object.entries(event).filter(([key]) => key.startsWith("actor_")))).toEqual(actor);
  const detail = await run(["activity", "view", event.id], declarations);
  expect(detail.stdout).toContain((await run(["whoami"], declarations)).stdout.trimEnd());
  await identify(declarations);
  expect(JSON.parse((await run(["activity", "list", "--json"], declarations)).stdout)).toEqual([event]);
});
