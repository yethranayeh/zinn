import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Activity } from "@zinn-dev/core";
import { runZinn, runZinnAs, withIsolatedZinnDir, withTestDb } from "../test-helpers";

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string | null; actor_email: string | null; actor_kind: string; actor_source: string | null }, []>(
      "SELECT action, actor_name, actor_email, actor_kind, actor_source FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect((await runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });
    expect((await runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });

    expect((await runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human", actor_source: "git-config" });

    expect((await runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null", USER: userInfo().username })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human", actor_source: "os-user" });
  });
});

test("CLI mutations preserve declared identity pairs and metadata without recording no-ops or failures", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const declared = {
      AI_AGENT: "integration-client", ZINN_SESSION_ID: " conversation ", ZINN_THREAD_ID: " child ",
      ZINN_AGENT: " Explore ", ZINN_MODEL: " provider/model ", ZINN_EFFORT: " 0.7 ",
      CLAUDE_CODE_SESSION_ID: "native-session", CODEX_SESSION_ID: "codex-session", CODEX_THREAD_ID: "codex-thread",
    };
    const events = async (): Promise<Array<Activity>> => JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout);
    expect((await runZinnAs(["project", "create", "IDENTITY"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "create", "IDENTITY", "--title", "Tracked"], directory, declared)).code).toBe(0);
    const item = (await events())[0]!;
    expect(item).toMatchObject({
      actor_name: "integration-client", actor_kind: "agent", actor_source: "env:AI_AGENT",
      actor_session_id: "conversation", actor_thread_id: "child", actor_agent: "Explore",
      actor_model: "provider/model", actor_effort: "0.7",
    });
    const before = await events();
    expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", "Tracked"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "move", "IDENTITY-1", "Missing"], directory, declared)).code).toBe(1);
    expect(await events()).toEqual(before);

    const cases: Array<{ env: Record<string, string>; name: string | null; session: string | null; thread: string | null }> = [
      { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-root", CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread" }, name: "claude-code", session: "claude-root", thread: null },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-root" }, name: "codex", session: "codex-root", thread: "codex-root" },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-child" }, name: "codex", session: "codex-root", thread: "codex-child" },
      { env: { CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread", ZINN_THREAD_ID: "explicit-child" }, name: "codex", session: null, thread: "explicit-child" },
      { env: { AGENT: "1", OPENCODE: "1" }, name: "opencode", session: null, thread: null },
      { env: { AGENT: "1" }, name: null, session: null, thread: null },
    ];
    for (const [index, entry] of cases.entries()) {
      expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", `Change ${index}`], directory, entry.env)).code).toBe(0);
      expect((await events())[0]).toMatchObject({
        actor_name: entry.name, actor_kind: "agent", actor_session_id: entry.session, actor_thread_id: entry.thread,
        actor_agent: null, actor_model: null, actor_effort: null,
      });
    }
    const unnamed = (await events())[0]!;
    expect(unnamed.actor_source).toBe("env:AGENT");
    expect((await runZinn(["activity", "list", "--limit", "1"], directory)).stdout).toContain("unknown (agent)");
    const view = await runZinn(["activity", "view", unnamed.id], directory);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("unknown");
    expect(JSON.parse((await runZinn(["activity", "view", unnamed.id, "--json"], directory)).stdout).actor_name).toBeNull();
  });
});
