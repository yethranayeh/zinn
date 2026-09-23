import type { Actor } from "@zinn-dev/core";

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

type Env = Record<string, string | undefined>;
type AgentMarker = { variables: Array<string>; name: string | null };

/**
 * Environment variables that coding agents set in the shells they run.
 * Undetected tools can set `AI_AGENT` through their own env configuration.
 */
const AGENT_MARKERS: Array<AgentMarker> = [
  { variables: ["AI_AGENT"], name: null },
  { variables: ["AGENT"], name: null },
  { variables: ["CLAUDECODE"], name: "claude-code" },
  { variables: ["CODEX_THREAD_ID", "CODEX_SANDBOX"], name: "codex" },
  { variables: ["OPENCODE"], name: "opencode" },
  { variables: ["GEMINI_CLI"], name: "gemini-cli" },
  { variables: ["CLINE_ACTIVE"], name: "cline" },
  { variables: ["CURSOR_AGENT"], name: "cursor" },
  { variables: ["COPILOT_AGENT_SESSION_ID"], name: "copilot" },
  { variables: ["CRUSH"], name: "crush" },
];

/** A marker without a fixed name records the variable's own value, e.g. `AI_AGENT=claude-code_2-1-280_agent`. */
export function detectAgent(env: Env): Actor | null {
  for (const marker of AGENT_MARKERS) {
    for (const variable of marker.variables) {
      const value = env[variable]?.trim();
      if (value == null || value.length === 0) {
        continue;
      }

      return { name: marker.name ?? value, email: null, kind: "agent" };
    }
  }

  return null;
}

function readGitConfig(key: string) {
  try {
    const value = execFileSync("git", ["config", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return value.length > 0 ? value : null;
  } catch {
    // git is missing or the key is unset
    return null;
  }
}

function resolveActor(): Actor {
  const agent = detectAgent(process.env);
  if (agent != null) {
    return agent;
  }

  const gitName = readGitConfig("user.name");
  if (gitName != null) {
    return { name: gitName, email: readGitConfig("user.email"), kind: "human" };
  }

  return { name: userInfo().username, email: null, kind: "human" };
}

let actor: Actor | null = null;

export function currentActor(): Actor {
  if (actor == null) {
    actor = resolveActor();
  }

  return actor;
}
