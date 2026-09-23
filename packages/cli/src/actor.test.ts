import type { Actor } from "@zinn-dev/core";

import { expect, test } from "bun:test";

import { detectAgent } from "./actor";

const agent = (name: string): Actor => ({ name, email: null, kind: "agent" });

test("AI_AGENT is recorded as given, ahead of tool markers", () => {
  expect(detectAgent({ AI_AGENT: "claude-code_2-1-280_agent", CLAUDECODE: "1" })).toEqual(
    agent("claude-code_2-1-280_agent"),
  );
  expect(detectAgent({ AI_AGENT: "hermes" })).toEqual(agent("hermes"));
});

test("AGENT comes before CLAUDECODE, since Amp sets both", () => {
  expect(detectAgent({ AGENT: "amp", CLAUDECODE: "1" })).toEqual(agent("amp"));
});

test("tool-specific markers map to fixed names", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ CLAUDECODE: "1" }, "claude-code"],
    [{ CODEX_THREAD_ID: "thread" }, "codex"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ OPENCODE: "1" }, "opencode"],
    [{ GEMINI_CLI: "1" }, "gemini-cli"],
    [{ CLINE_ACTIVE: "true" }, "cline"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ COPILOT_AGENT_SESSION_ID: "session" }, "copilot"],
    [{ CRUSH: "1" }, "crush"],
  ];

  for (const [env, name] of cases) {
    expect(detectAgent(env)).toEqual(agent(name));
  }
});

test("empty or unrelated variables are not agents", () => {
  expect(detectAgent({})).toBeNull();
  expect(detectAgent({ AI_AGENT: "  ", AGENT: "", HOME: "/home/someone" })).toBeNull();
});
