import type { Settings } from "../settings";
import type { CliReader, Task } from "../shared/cli";

import { argvKeys } from "../shared/keys";

export type TaskRead = {
  kind: "idle" | "ready" | "invalid" | "missing" | "error";
  store: string;
  key?: string;
  task?: Task;
  error?: string;
  fetchedAt?: string;
};

export async function readTask(
  settings: Settings,
  rawKey: string | undefined,
  reader: CliReader,
  signal?: AbortSignal,
): Promise<TaskRead> {
  const { store } = settings;
  if (rawKey === undefined) {
    return { kind: "idle", store };
  }

  const key = rawKey.trim().toUpperCase();
  if (argvKeys([key])[0] !== key) {
    return { kind: "invalid", store, key, error: "Enter a task key such as APP-1." };
  }

  const result = await reader.run(["task", "view", key], signal);
  if (result.ok) {
    if (result.value?.key !== key || typeof result.value.title !== "string") {
      return { kind: "error", store, key, error: "Unexpected task details from Zinn." };
    }

    return { kind: "ready", store, key, task: result.value, fetchedAt: new Date().toISOString() };
  }

  const missing =
    result.code === "not_found" && (result.entity === "task" || result.entity === "project");
  return { kind: missing ? "missing" : "error", store, key, error: result.error };
}
