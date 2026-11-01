import type { Settings } from "../settings";
import type { CliReader } from "../shared/cli";
import type {
  PresentedColumnTaskCount,
  PresentedTaskChange,
} from "../../../../packages/cli/src/result-schemas.js";

import { createCliReader } from "../shared/cli";
import { argvKeys, projectOf } from "../shared/keys";
import { readTask } from "./task-reader";

const HUMAN_ACTOR_ENVIRONMENT: NodeJS.ProcessEnv = {
  AI_AGENT: undefined,
  AGENT: undefined,
  CLAUDECODE: undefined,
  CODEX_THREAD_ID: undefined,
  CODEX_SANDBOX: undefined,
  OPENCODE: undefined,
  GEMINI_CLI: undefined,
  CLINE_ACTIVE: undefined,
  CURSOR_AGENT: undefined,
  COPILOT_AGENT_SESSION_ID: undefined,
  CRUSH: undefined,
  ZINN_SESSION_ID: undefined,
  ZINN_THREAD_ID: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  CODEX_SESSION_ID: undefined,
  OPENCODE_SESSION_ID: undefined,
  ZINN_AGENT: undefined,
  ZINN_MODEL: undefined,
  ZINN_EFFORT: undefined,
};

export type TaskColumnsRead = {
  kind: "ready" | "error";
  store: string;
  key: string;
  columns?: Array<PresentedColumnTaskCount>;
  error?: string;
};

export type TaskMoveRead = {
  kind: "ready" | "error";
  store: string;
  key: string;
  task?: PresentedTaskChange;
  changed?: boolean;
  error?: string;
};

function normalizedTaskKey(rawKey: string) {
  const key = rawKey.trim().toUpperCase();
  return argvKeys([key])[0] === key ? key : null;
}

export async function readTaskColumns(
  settings: Settings,
  rawKey: string,
  reader: CliReader,
  signal?: AbortSignal,
): Promise<TaskColumnsRead> {
  const validKey = normalizedTaskKey(rawKey);
  const key = validKey ?? rawKey.trim().toUpperCase();
  if (validKey === null) {
    return { kind: "error", store: settings.store, key, error: "Enter a task key such as APP-1." };
  }

  const taskRead = await readTask(settings, key, reader, signal);
  if (taskRead.kind !== "ready") {
    return {
      kind: "error",
      store: settings.store,
      key,
      error: taskRead.error ?? "Could not read the selected task.",
    };
  }

  const result = await reader.run<Array<PresentedColumnTaskCount>>(
    ["project", "column", "list", projectOf(key)],
    signal,
  );
  if (!result.ok) {
    return { kind: "error", store: settings.store, key, error: result.error };
  }

  return { kind: "ready", store: settings.store, key, columns: result.value };
}

export async function moveTask(
  settings: Settings,
  rawKey: string,
  column: string,
  reader: CliReader,
  signal?: AbortSignal,
): Promise<TaskMoveRead> {
  const validKey = normalizedTaskKey(rawKey);
  const key = validKey ?? rawKey.trim().toUpperCase();
  if (validKey === null) {
    return { kind: "error", store: settings.store, key, error: "Enter a task key such as APP-1." };
  }

  const result = await reader.run<PresentedTaskChange>(["task", "move", "--", key, column], signal);
  if (!result.ok) {
    return { kind: "error", store: settings.store, key, error: result.error };
  }

  return {
    kind: "ready",
    store: settings.store,
    key,
    task: result.value,
    changed: result.value.changed,
  };
}

export function createHumanActionReader(settings: Settings): CliReader {
  // Preserve configured CLI environment while removing inherited agent attribution.
  return createCliReader(settings, { env: HUMAN_ACTOR_ENVIRONMENT });
}
