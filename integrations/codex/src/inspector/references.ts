import type { Settings } from "../settings";
import type { Task } from "../shared/cli";

import { readFeed } from "../shared/feed";
import { readTaskList } from "../shared/cli";

type ReadReference = {
  key: string;
  source: string | null;
  task?: Pick<Task, "key" | "title" | "column" | "status">;
};
export type RecentRead = {
  kind: "ready" | "absent_metadata" | "conflicting_metadata" | "no_feed" | "error";
  store: string;
  references: Array<ReadReference>;
  incomplete: number;
  atCapacity: boolean;
  replyFailures?: number;
  error?: string;
};

export function resolveChat(metadata?: Record<string, unknown>) {
  const snake =
    typeof metadata?.thread_id === "string" && metadata.thread_id !== ""
      ? metadata.thread_id
      : undefined;
  const camel =
    typeof metadata?.threadId === "string" && metadata.threadId !== ""
      ? metadata.threadId
      : undefined;
  if (snake && camel && snake !== camel) {
    return { kind: "conflicting_metadata" as const, session: undefined };
  }

  const session = snake ?? camel;
  return { kind: session ? ("bound" as const) : ("absent_metadata" as const), session };
}

export function readRecent(
  settings: Settings,
  metadata?: Record<string, unknown>,
  alreadyProtected = false,
): RecentRead {
  const empty = { store: settings.store, references: [], incomplete: 0, atCapacity: false };
  const binding = resolveChat(metadata);

  if (binding.session === undefined) {
    return {
      ...empty,
      kind: binding.kind === "conflicting_metadata" ? "conflicting_metadata" : "absent_metadata",
    };
  }

  try {
    const feed = readFeed(settings.dataDirectory, binding.session, settings.store);
    if (!feed.present) {
      return { ...empty, kind: "no_feed" };
    }

    const result = {
      ...empty,
      references: feed.references,
      incomplete: feed.incomplete,
      atCapacity: feed.atCapacity,
      replyFailures: feed.replyFailures,
    };

    if (feed.references.length === 0) {
      return { ...result, kind: "ready" };
    }

    const tasks = readTaskList(settings, alreadyProtected);
    if (!tasks.ok || !Array.isArray(tasks.value)) {
      return {
        ...result,
        kind: "error",
        error: tasks.ok ? "Unexpected task list from Zinn." : tasks.error,
      };
    }

    const byKey = new Map<string, Task>(tasks.value.map((task: Task) => [task.key, task]));
    return {
      ...result,
      kind: "ready",
      references: feed.references.map(({ key, source }) => {
        const task = byKey.get(key);
        return {
          key,
          source,
          task: task
            ? { key: task.key, title: task.title, column: task.column, status: task.status }
            : undefined,
        };
      }),
    };
  } catch {
    return { ...empty, kind: "error", error: "Could not read this chat's observed references." };
  }
}
