import type { Ctx } from "./types.ts";

import { isRecord, runZinn } from "./data.ts";

// Bound concurrent CLI reads across visible tasks.
export const PROBE_CONCURRENCY = 8;
export let activityProbesSupported = true;
// Session and thread filters are separate reads because the CLI combines them with AND.
export async function probeSessionTask(
  sessionID: string,
  key: string,
): Promise<{
  mine: boolean;
  unsupported: boolean;
}> {
  let unsupported = false;
  const filters = [
    { flag: "--session", field: "actor_session_id" },
    { flag: "--thread", field: "actor_thread_id" },
  ] as const;

  for (const { flag, field } of filters) {
    const result = await runZinn([
      "activity",
      "list",
      "--task",
      key,
      flag,
      sessionID,
      "--json",
      "--limit",
      "1",
    ]);

    if (!result.ok) {
      unsupported ||= result.code === "invalid_input";
      continue;
    }

    let data: unknown;
    try {
      data = JSON.parse(result.value);
    } catch {
      continue;
    }

    if (Array.isArray(data) && data.some((row) => isRecord(row) && row[field] === sessionID)) {
      return { mine: true, unsupported: false };
    }
  }

  return { mine: false, unsupported };
}
// Child-session writes belong to the same chat family.
export function probeSessions(ctx: Ctx, sessionID: string): string[] {
  const ids = new Set<string>();
  if (sessionID !== "") {
    ids.add(sessionID);
  }

  try {
    const root = ctx.data.session.root(sessionID);
    if (typeof root === "string" && root !== "") {
      ids.add(root);
    }
  } catch {}

  try {
    const family = ctx.data.session.family(sessionID);
    if (Array.isArray(family)) {
      for (const id of family) {
        if (typeof id === "string" && id !== "") {
          ids.add(id);
        }
      }
    }
  } catch {}

  return [...ids];
}

export async function probeAnySession(
  sessions: readonly string[],
  key: string,
): Promise<{
  mine: boolean;
  unsupported: boolean;
}> {
  let unsupported = false;

  for (const sid of sessions) {
    const probe = await probeSessionTask(sid, key);
    if (probe.unsupported) {
      unsupported = true;
      continue;
    }
    if (probe.mine) {
      return { mine: true, unsupported: false };
    }
  }
  return { mine: false, unsupported };
}

// Superseded cycles stop scheduling reads already waiting for a lane.
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let next = 0;
  const lanes: Promise<void>[] = [];
  const stopped = () => shouldStop !== undefined && shouldStop();
  const drive = async () => {
    while (next < items.length) {
      if (stopped()) {
        return;
      }
      const item = items[next++]!;
      await worker(item);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    lanes.push(drive());
  }
  await Promise.all(lanes);
}

export function sessionTab(ctx: Ctx, sessionID: string) {
  const tabs: Ctx["ui"]["tabs"] | undefined = ctx.ui.tabs;
  if (tabs === undefined) {
    return undefined;
  }

  if (typeof tabs.enabled !== "function" || typeof tabs.list !== "function") {
    return undefined;
  }

  if (!tabs.enabled()) {
    return undefined;
  }

  const list = tabs.list();
  if (!Array.isArray(list)) {
    return undefined;
  }

  return list.find((candidate) => candidate.sessionID === sessionID);
}
export function sessionWaiting(ctx: Ctx, sessionID: string): boolean {
  const permissions = ctx.data.session.permission?.list(sessionID);
  if ((permissions?.length ?? 0) > 0) {
    return true;
  }

  const forms = ctx.data.session.form?.list(sessionID);
  return (forms?.length ?? 0) > 0;
}
export function sessionRunning(ctx: Ctx, sessionID: string): boolean {
  const tab = sessionTab(ctx, sessionID);
  if (tab !== undefined) {
    return tab.busy;
  }

  if (sessionWaiting(ctx, sessionID)) {
    return false;
  }

  const status: unknown = ctx.data.session.status?.(sessionID);
  const type = isRecord(status) ? status["type"] : status;
  return type === "running" || type === "busy";
}
export function disableActivityProbes(): void {
  activityProbesSupported = false;
}
