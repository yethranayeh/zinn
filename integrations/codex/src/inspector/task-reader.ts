import type { Settings } from "../settings";
import type { Task } from "../shared/cli";

import { runCli, readTaskList } from "../shared/cli";
import { argvKeys } from "../shared/keys";

export type TaskRead = {
  kind: "idle" | "ready" | "invalid" | "missing" | "error";
  store: string;
  key?: string;
  task?: Task;
  error?: string;
  fetchedAt?: string;
};

export function readTask(settings: Settings, rawKey?: string, alreadyProtected = false): TaskRead {
  const { store } = settings;
  if (rawKey === undefined) {
    return { kind: "idle", store };
  }

  const key = rawKey.trim().toUpperCase();
  if (argvKeys([key])[0] !== key) {
    return { kind: "invalid", store, key, error: "Enter a task key such as APP-1." };
  }

  const result = runCli(settings, ["task", "view", key], alreadyProtected);
  if (result.ok) {
    if (result.value?.key !== key || typeof result.value.title !== "string") {
      return { kind: "error", store, key, error: "Unexpected task details from Zinn." };
    }

    return { kind: "ready", store, key, task: result.value, fetchedAt: new Date().toISOString() };
  }

  const list = readTaskList(settings, alreadyProtected);
  const missing =
    list.ok && Array.isArray(list.value) && !list.value.some((task: Task) => task.key === key);
  return { kind: missing ? "missing" : "error", store, key, error: result.error };
}
