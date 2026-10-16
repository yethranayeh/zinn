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

const SESSION_DECLARATIONS = [
  { session: "ZINN_SESSION_ID", thread: "ZINN_THREAD_ID" },
  { session: "CLAUDE_CODE_SESSION_ID", thread: null },
  { session: "CODEX_SESSION_ID", thread: "CODEX_THREAD_ID" },
] as const;

function readDeclaration(env: Env, variable: string | null): string | null {
  const value = variable === null ? undefined : env[variable]?.trim();
  return value == null || value.length === 0 ? null : value;
}

function readExecutionIdentity(env: Env) {
  let sessionId: string | null = null;
  let threadId: string | null = null;

  for (const declaration of SESSION_DECLARATIONS) {
    const declaredSession = readDeclaration(env, declaration.session);
    const declaredThread = readDeclaration(env, declaration.thread);
    const hasDeclaration = declaredSession !== null || declaredThread !== null;

    if (hasDeclaration) {
      sessionId = declaredSession;
      threadId = declaredThread;
      break;
    }
  }

  return {
    sessionId,
    threadId,
    agent: readDeclaration(env, "ZINN_AGENT"),
    model: readDeclaration(env, "ZINN_MODEL"),
    effort: readDeclaration(env, "ZINN_EFFORT"),
  };
}

/** Generic flags establish an unnamed agent only when no identifying marker follows. */
export function detectAgent(env: Env): Actor | null {
  let flagSource: string | null = null;

  for (const marker of AGENT_MARKERS) {
    for (const variable of marker.variables) {
      const value = readDeclaration(env, variable);
      if (value === null) {
        continue;
      }

      const isGenericFlag =
        marker.name === null && /^(?:\d+|true|false|yes|no|on|off)$/i.test(value);
      if (isGenericFlag) {
        flagSource ??= `env:${variable}`;
        continue;
      }

      return {
        name: marker.name ?? value,
        email: null,
        kind: "agent",
        source: `env:${variable}`,
        ...readExecutionIdentity(env),
      };
    }
  }

  if (flagSource !== null) {
    return {
      name: null,
      email: null,
      kind: "agent",
      source: flagSource,
      ...readExecutionIdentity(env),
    };
  }

  return null;
}

function readGitConfig(key: string, env: Env) {
  try {
    const value = execFileSync("git", ["config", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();

    return value.length > 0 ? value : null;
  } catch {
    // git is missing or the key is unset
    return null;
  }
}

export function resolveActor(env: Env): Actor {
  const agent = detectAgent(env);
  if (agent != null) {
    return agent;
  }

  const identity = readExecutionIdentity(env);
  const gitName = readGitConfig("user.name", env);
  if (gitName != null) {
    return {
      name: gitName,
      email: readGitConfig("user.email", env),
      kind: "human",
      source: "git-config",
      ...identity,
    };
  }

  return {
    name: userInfo().username,
    email: null,
    kind: "human",
    source: "os-user",
    ...identity,
  };
}

let actor: Actor | null = null;

export function currentActor(): Actor {
  if (actor == null) {
    actor = resolveActor(process.env);
  }

  return actor;
}
