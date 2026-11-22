import type { Ctx, Loaded, Mention, Scan, TaskSummary } from "./types.ts";

import { activeTaskMap, errorText, loadKeyMap, log } from "./data.ts";
import { mentionCounts, scanSession } from "./scan.ts";

export type SessionSnapshot = {
  sessionID: string;
  map: Map<string, TaskSummary> | undefined;
  activeMap: Map<string, TaskSummary>;
  known: readonly Mention[];
  counts: ReadonlyMap<string, number>;
};

export type SessionSnapshotResult =
  | {
      kind: "no-session";
    }
  | {
      kind: "error";
      error: string;
    }
  | {
      kind: "ready";
      snapshot: SessionSnapshot;
    };

type CurrentRoute = ReturnType<Ctx["ui"]["router"]["current"]>;
export type SessionSnapshotSource = {
  currentRoute: () => CurrentRoute;
  syncMessages: (sessionID: string) => Promise<void>;
  loadBoard: () => Promise<Loaded<Map<string, TaskSummary>>>;
  scan: (sessionID: string, map: Map<string, TaskSummary>) => Scan;
  log: (message: string, extra?: Record<string, unknown>) => void;
};

export function sessionSnapshotSource(ctx: Ctx): SessionSnapshotSource {
  return {
    currentRoute: () => ctx.ui.router.current(),
    syncMessages: (sessionID) => ctx.data.session.message.sync(sessionID),
    loadBoard: loadKeyMap,
    scan: (sessionID, map) => scanSession(ctx, sessionID, map),
    log: (message, extra) => log(ctx, message, extra),
  };
}

/** Reads the open session, its board and its mentions once, without relying on the sidebar. */
export async function loadSessionSnapshot(
  source: SessionSnapshotSource,
): Promise<SessionSnapshotResult> {
  const route = source.currentRoute();
  if (route.type !== "session") {
    return { kind: "no-session" };
  }

  const sessionID = route.sessionID;
  try {
    await source.syncMessages(sessionID);
  } catch (error) {
    source.log("message sync failed", { reason: "command", error: errorText(error) });
  }

  const loaded = await source.loadBoard();
  if (!loaded.ok) {
    return { kind: "error", error: loaded.error };
  }

  const scan = source.scan(sessionID, loaded.value);
  return {
    kind: "ready",
    snapshot: {
      sessionID,
      map: loaded.value,
      activeMap: activeTaskMap(loaded.value),
      known: scan.known,
      counts: mentionCounts(scan.known),
    },
  };
}
