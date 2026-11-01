import type { SettingsOptions } from "../settings";
import type { HookPayload } from "./types";
import type { Observation, Reference } from "../shared/feed";
import type { PresentedInfo } from "../../../../packages/cli/src/result-schemas.js";

import { isAbsolute, resolve } from "node:path";
import { resolveSettings } from "../settings";

import { createCliReader, HOOK_VERIFICATION_BUDGET_MS, readTaskList } from "../shared/cli";
import { calls } from "../shared/calls";
import { argvKeys, keyCandidates, projectOf } from "../shared/keys";
import { persist } from "../shared/feed";

export const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStop",
  "Stop",
] as const;

const MAX_TEXT_KEYS = 32;
const MAX_CALLS = 16;
const MAX_DISPATCH_KEYS = 6;

export async function observe(
  payload: HookPayload,
  settings: SettingsOptions,
  {
    deadline = performance.now() + HOOK_VERIFICATION_BUDGET_MS,
    signal,
  }: { deadline?: number; signal?: AbortSignal } = {},
): Promise<void> {
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
    const inheritedStore = process.env.ZINN_DIR || null;
    const storesByDirectory = new Map<string, string | null>();

    for (const call of calls(
      payload.tool_input.command,
      settings.cli,
      payload.cwd ?? null,
      inheritedStore,
    ).slice(0, MAX_CALLS)) {
      let store = call.store;
      const needsDiscovery =
        call.storeKnown && store === null && call.cwd !== null && isAbsolute(call.cwd);

      if (needsDiscovery) {
        const cwd = call.cwd!;
        if (!storesByDirectory.has(cwd)) {
          try {
            const selection = await resolveSettings(
              { ...settings, store: undefined },
              { deadline, signal, cwd },
            );
            storesByDirectory.set(cwd, selection.settings.store);
          } catch {
            storesByDirectory.set(cwd, null);
          }
        }
        store = storesByDirectory.get(cwd) ?? null;
      }

      if (call.storeKnown && store !== null && isAbsolute(store)) {
        for (const key of argvKeys(call.argv)) {
          add(key, "argv", resolve(store));
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
    const resolution = await resolveSettings(settings, { deadline, signal });
    const selected = resolution.settings;
    const reader = createCliReader(selected, { deadline });
    let result;

    try {
      const info = resolution.info ?? (await reader.run<PresentedInfo>(["info"], signal));
      const current =
        info.ok && info.value?.database?.state === "current" && info.value.database.error === null;
      result = current ? await readTaskList(reader, signal) : { ok: false as const };
    } finally {
      await reader.close();
    }

    if (
      result.ok &&
      Array.isArray(result.value) &&
      result.value.every((task) => typeof task?.key === "string")
    ) {
      const known = new Set<string>(result.value.map((task) => task.key.toUpperCase()));
      const prefixes = new Set([...known].map(projectOf));

      for (const key of candidates) {
        if (known.has(key) || (completed && prefixes.has(projectOf(key)))) {
          add(key, completed ? "completed-reply" : "dispatch", selected.store);
        }
      }
    } else if (completed) {
      replyFailedStore = selected.store;
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
