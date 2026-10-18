import type { Actor } from "@zinn-dev/core";

import { expect, test } from "bun:test";

import { detectAgent, resolveActor } from "./actor";

type Env = Record<string, string | undefined>;

function agent(
  name: string | null,
  source: string,
  identity: Partial<Pick<Actor, "sessionId" | "threadId" | "agent" | "model" | "effort">> = {},
): Actor {
  return {
    name,
    email: null,
    kind: "agent",
    source,
    sessionId: null,
    threadId: null,
    agent: null,
    model: null,
    effort: null,
    ...identity,
  };
}

test("AI_AGENT is recorded as given, ahead of tool markers", () => {
  expect(
    detectAgent({ AI_AGENT: "claude-code_2-1-280_agent", CLAUDECODE: "1" }),
  ).toEqual(agent("claude-code_2-1-280_agent", "env:AI_AGENT"));
  expect(detectAgent({ AI_AGENT: "hermes" })).toEqual(agent("hermes", "env:AI_AGENT"));
});

test("AGENT comes before CLAUDECODE, since Amp sets both", () => {
  expect(detectAgent({ AGENT: "amp", CLAUDECODE: "1" })).toEqual(agent("amp", "env:AGENT"));
});

test("tool-specific markers keep their existing names and record their deciding variable", () => {
  const cases: Array<[Env, string, string, Partial<Pick<Actor, "sessionId" | "threadId">>?]> = [
    [{ CLAUDECODE: "1" }, "claude-code", "CLAUDECODE"],
    [{ CODEX_THREAD_ID: "thread" }, "codex", "CODEX_THREAD_ID", { threadId: "thread" }],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex", "CODEX_SANDBOX"],
    [{ OPENCODE: "1" }, "opencode", "OPENCODE"],
    [{ GEMINI_CLI: "1" }, "gemini-cli", "GEMINI_CLI"],
    [{ CLINE_ACTIVE: "true" }, "cline", "CLINE_ACTIVE"],
    [{ CURSOR_AGENT: "1" }, "cursor", "CURSOR_AGENT"],
    [{ COPILOT_AGENT_SESSION_ID: "session" }, "copilot", "COPILOT_AGENT_SESSION_ID"],
    [{ CRUSH: "1" }, "crush", "CRUSH"],
  ];

  for (const [env, name, variable, identity] of cases) {
    expect(detectAgent(env)).toEqual(agent(name, `env:${variable}`, identity));
  }
});

test("numeric and boolean AI_AGENT or AGENT values are flags", () => {
  const flagValues = ["0", "01", "42", "TRUE", "False", "yes", "NO", "on", "OFF"];

  for (const variable of ["AI_AGENT", "AGENT"] as const) {
    for (const value of flagValues) {
      expect(detectAgent({ [variable]: value })).toEqual(agent(null, `env:${variable}`));
    }
  }

  expect(detectAgent({ AI_AGENT: "1", AGENT: "false" })).toEqual(agent(null, "env:AI_AGENT"));
});

test("flag values continue to named markers and do not mask a named AGENT", () => {
  expect(detectAgent({ AGENT: "1", OPENCODE: "1" })).toEqual(agent("opencode", "env:OPENCODE"));
  expect(detectAgent({ AI_AGENT: "opencode", AGENT: "1", OPENCODE: "1" })).toEqual(
    agent("opencode", "env:AI_AGENT"),
  );
  expect(detectAgent({ AI_AGENT: "false", AGENT: "amp", CLAUDECODE: "1" })).toEqual(
    agent("amp", "env:AGENT"),
  );
  expect(detectAgent({ AI_AGENT: "1", AGENT: "no", OPENCODE: "1" })).toEqual(
    agent("opencode", "env:OPENCODE"),
  );
});

test("ZINN declarations carry the six identity fields and trim blank edges", () => {
  expect(
    detectAgent({
      AI_AGENT: "test-agent",
      ZINN_SESSION_ID: "session/1",
      ZINN_THREAD_ID: "thread/2",
      ZINN_AGENT: "Explore",
      ZINN_MODEL: "provider/model",
      ZINN_EFFORT: "0.7",
    }),
  ).toEqual(
    agent("test-agent", "env:AI_AGENT", {
      sessionId: "session/1",
      threadId: "thread/2",
      agent: "Explore",
      model: "provider/model",
      effort: "0.7",
    }),
  );

  expect(
    detectAgent({
      OPENCODE: "1",
      ZINN_SESSION_ID: "  ",
      ZINN_THREAD_ID: "",
      ZINN_AGENT: " \t",
      ZINN_MODEL: "",
      ZINN_EFFORT: "  ",
    }),
  ).toEqual(agent("opencode", "env:OPENCODE"));
});

test("the selected session and thread always come from one declarer", () => {
  expect(
    detectAgent({
      AI_AGENT: "test-agent",
      ZINN_SESSION_ID: "zinn-session",
      ZINN_THREAD_ID: "zinn-thread",
      CLAUDE_CODE_SESSION_ID: "claude-session",
      CODEX_SESSION_ID: "codex-session",
      CODEX_THREAD_ID: "codex-thread",
    }),
  ).toEqual(
    agent("test-agent", "env:AI_AGENT", { sessionId: "zinn-session", threadId: "zinn-thread" }),
  );

  expect(
    detectAgent({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "claude-session",
      CODEX_SESSION_ID: "codex-session",
      CODEX_THREAD_ID: "codex-thread",
    }),
  ).toEqual(agent("claude-code", "env:CLAUDECODE", { sessionId: "claude-session" }));

  expect(
    detectAgent({ CODEX_SESSION_ID: "parent-session", CODEX_THREAD_ID: "child-thread" }),
  ).toEqual(agent("codex", "env:CODEX_THREAD_ID", { sessionId: "parent-session", threadId: "child-thread" }));
});

test("a partial ZINN pair wins as a pair instead of borrowing a native value", () => {
  expect(
    detectAgent({
      CLAUDECODE: "1",
      ZINN_SESSION_ID: "zinn-session",
      ZINN_THREAD_ID: "",
      CLAUDE_CODE_SESSION_ID: "claude-session",
      CODEX_SESSION_ID: "codex-session",
      CODEX_THREAD_ID: "codex-thread",
    }),
  ).toEqual(agent("claude-code", "env:CLAUDECODE", { sessionId: "zinn-session" }));

  expect(
    detectAgent({ OPENCODE: "1", ZINN_THREAD_ID: "zinn-thread", CODEX_SESSION_ID: "codex-session" }),
  ).toEqual(agent("opencode", "env:OPENCODE", { threadId: "zinn-thread" }));

  expect(
    detectAgent({
      CLAUDECODE: "1", ZINN_SESSION_ID: " ", ZINN_THREAD_ID: "\t",
      CLAUDE_CODE_SESSION_ID: "claude-session", CODEX_THREAD_ID: "outer-thread",
    }),
  ).toEqual(agent("claude-code", "env:CLAUDECODE", { sessionId: "claude-session" }));
});

test("deferred native session values stay unset while Copilot remains a marker", () => {
  expect(
    detectAgent({
      COPILOT_AGENT_SESSION_ID: "copilot-session",
      OPENCODE_SESSION_ID: "opencode-session",
      HERMES_SESSION_ID: "hermes-session",
      CLAUDE_CODE_CHILD_SESSION: "1",
    }),
  ).toEqual(agent("copilot", "env:COPILOT_AGENT_SESSION_ID"));
});

// ZINN-290: a Claude Code subagent's shell carries its own CLAUDE_EFFORT.
test("CLAUDE_EFFORT is the effort unless ZINN_EFFORT declares one", () => {
  expect(detectAgent({ CLAUDECODE: "1", CLAUDE_EFFORT: " high " })).toEqual(
    agent("claude-code", "env:CLAUDECODE", { effort: "high" }),
  );
  expect(detectAgent({ CLAUDECODE: "1", CLAUDE_EFFORT: "high", ZINN_EFFORT: "low" })?.effort).toBe("low");
  expect(detectAgent({ CLAUDECODE: "1", CLAUDE_EFFORT: "high", ZINN_EFFORT: " " })?.effort).toBe("high");
  expect(detectAgent({ CLAUDECODE: "1", CLAUDE_EFFORT: "" })?.effort).toBeNull();
});

test("empty or unrelated variables are not agents", () => {
  expect(detectAgent({})).toBeNull();
  expect(detectAgent({ AI_AGENT: "  ", AGENT: "", HOME: "/home/someone" })).toBeNull();
  expect(detectAgent({ ZINN_SESSION_ID: "session", ZINN_MODEL: "model" })).toBeNull();
});

test("human fallback keeps explicit null identity fields and accepts declared metadata", () => {
  const fallback = resolveActor({});
  expect(fallback.kind).toBe("human");
  expect(typeof fallback.name).toBe("string");
  expect(fallback.name?.length).toBeGreaterThan(0);
  expect(["git-config", "os-user"]).toContain(fallback.source as string);
  expect(fallback.sessionId).toBeNull();
  expect(fallback.threadId).toBeNull();
  expect(fallback.agent).toBeNull();
  expect(fallback.model).toBeNull();
  expect(fallback.effort).toBeNull();

  const declared = resolveActor({
    ZINN_SESSION_ID: "human-session",
    ZINN_THREAD_ID: "human-thread",
    ZINN_AGENT: "general",
    ZINN_MODEL: "provider/model",
    ZINN_EFFORT: "medium",
  });
  expect(declared.kind).toBe("human");
  expect(declared.source).toBe(fallback.source);
  expect(declared.sessionId).toBe("human-session");
  expect(declared.threadId).toBe("human-thread");
  expect(declared.agent).toBe("general");
  expect(declared.model).toBe("provider/model");
  expect(declared.effort).toBe("medium");
});
