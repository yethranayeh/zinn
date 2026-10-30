import type { HookPayload } from "./types";

import { calls } from "../shared/calls";
import { segments } from "../shared/shell";

const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const declaration = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// Limit rewriting to one literal direct command.
export function simpleWords(command: string): string[] | null {
  let quoted: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quoted === "'") {
      if (character === "'") {
        quoted = null;
      }
      continue;
    }

    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined || next === "\n" || next === "\r") {
        return null;
      }
      index++;
      continue;
    }

    if (character === "$" || character === "`" || character === "\0") {
      return null;
    }

    if (quoted === '"') {
      if (character === '"') {
        quoted = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quoted = character;
      continue;
    }

    if (";&|()<>\n\r#{}".includes(character)) {
      return null;
    }
  }

  if (quoted !== null) {
    return null;
  }

  const parsed = segments(command);
  return parsed.length === 1 ? parsed[0]! : null;
}

export function rewrite(
  payload: HookPayload,
  cli: readonly string[],
  effort: string | null = null,
): Record<string, unknown> | null {
  const command = payload.tool_input?.command;
  const matchesEvent = payload.hook_event_name === "PreToolUse" && payload.tool_name === "Bash";

  if (!matchesEvent || typeof command !== "string" || !declaration(payload.session_id)) {
    return null;
  }

  const words = simpleWords(command);
  if (words === null) {
    return null;
  }

  const executable = words.find((word) => !assignment.test(word));
  if (executable === undefined || (basename(executable) !== "zinn" && executable !== cli[0])) {
    return null;
  }

  const invocations = calls(command, cli, declaration(payload.cwd) || null, null);
  if (invocations.length !== 1) {
    return null;
  }

  const values = {
    ZINN_AGENT: declaration(payload.agent_type),
    ZINN_MODEL: declaration(payload.model),
    ZINN_EFFORT: effort ?? "",
    CLAUDE_EFFORT: "",
  };
  const prefix = Object.entries(values)
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...payload.tool_input, command: `${prefix} ${command}` },
    },
  };
}

import { basename } from "node:path";
