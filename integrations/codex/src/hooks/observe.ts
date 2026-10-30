import type { Settings } from "../settings";
import type { HookPayload } from "./types";
import type { Observation, Reference } from "../shared/feed";

import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { readTaskList } from "../shared/cli";
import { calls } from "../shared/calls";
import { argvKeys, keyCandidates, projectOf } from "../shared/keys";
import { persist } from "../shared/feed";

export const EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;

const MAX_TEXT_KEYS = 32;
const MAX_CALLS = 16;
const MAX_DISPATCH_KEYS = 6;

export function observe(payload: HookPayload, settings: Settings): void {
  if (!settings.observe || !payload.session_id) {
    return;
  }

  const references: Reference[] = [];
  const add = (key: string, source: Reference["source"], store: string) => {
    references.push({ key, source, store });
  };

  if (
    payload.hook_event_name === "PostToolUse" &&
    payload.tool_name === "Bash" &&
    typeof payload.tool_input?.command === "string"
  ) {
    const inherited = process.env.ZINN_DIR || resolve(homedir(), ".zinn");
    const inheritedStore = isAbsolute(inherited)
      ? inherited
      : payload.cwd
        ? resolve(payload.cwd, inherited)
        : null;

    for (const call of calls(
      payload.tool_input.command,
      settings.cli,
      payload.cwd ?? null,
      inheritedStore,
    ).slice(0, MAX_CALLS)) {
      if (call.storeKnown && call.store !== null && isAbsolute(call.store)) {
        for (const key of argvKeys(call.argv)) {
          add(key, "argv", resolve(call.store));
        }
      }
    }
  }

  const completed =
    payload.hook_event_name === "Stop" || payload.hook_event_name === "SubagentStop";
  const dispatched =
    payload.hook_event_name === "PreToolUse" &&
    ["Agent", "spawn_agent", "collaborationspawn_agent"].includes(payload.tool_name ?? "");
  const input = payload.tool_input;
  const dispatchText = [input?.description, input?.message, input?.prompt]
    .filter((value) => typeof value === "string")
    .join("\n");
  const text = completed ? payload.last_assistant_message : dispatched ? dispatchText : undefined;
  const candidates =
    typeof text === "string"
      ? keyCandidates(text, true).slice(0, dispatched ? MAX_DISPATCH_KEYS : MAX_TEXT_KEYS)
      : [];
  let replyFailedStore: string | null = null;

  if (candidates.length > 0) {
    const result = readTaskList(settings);

    if (
      result.ok &&
      Array.isArray(result.value) &&
      result.value.every((task) => typeof task?.key === "string")
    ) {
      const known = new Set<string>(result.value.map((task) => task.key.toUpperCase()));
      const prefixes = new Set([...known].map(projectOf));
      for (const key of candidates) {
        if (known.has(key) || (completed && prefixes.has(projectOf(key)))) {
          add(key, completed ? "completed-reply" : "dispatch", settings.store);
        }
      }
    } else if (completed) {
      replyFailedStore = settings.store;
    }
  }

  if (references.length === 0 && replyFailedStore === null) {
    return;
  }

  const observation: Observation = {
    version: 1,
    ts: new Date().toISOString(),
    session: payload.session_id,
    references,
    replyFailedStore,
  };

  persist(settings.dataDirectory, observation);
}
