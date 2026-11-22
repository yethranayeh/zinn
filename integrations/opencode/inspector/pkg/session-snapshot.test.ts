import { expect, test } from "bun:test";

import type { Scan, TaskSummary } from "./types.ts";

import { loadSessionSnapshot } from "./session-snapshot.ts";

function task(key: string, status: string): TaskSummary {
  return {
    key,
    title: key,
    status,
    column: "TODO",
    columnCategory: "todo",
    priority: null,
    labels: [],
    claim: null,
  };
}

function scanOf(known: Scan["known"]): Scan {
  return {
    known,
    unknown: [],
    tokens: known.length,
    textParts: 0,
    streamingParts: 0,
    zinnCommands: 0,
    ms: 0,
  };
}

const sessionRoute = () => ({ type: "session" as const, sessionID: "ses_open" });

test("a route without a session does not read the board", async () => {
  let boardReads = 0;
  const result = await loadSessionSnapshot({
    currentRoute: () => ({ type: "home" }),
    syncMessages: async () => {
      throw new Error("must not sync");
    },
    loadBoard: async () => {
      boardReads += 1;
      return { ok: true, value: new Map() };
    },
    scan: () => scanOf([]),
    log: () => {},
  });

  expect(result).toEqual({ kind: "no-session" });
  expect(boardReads).toBe(0);
});

test("a failed board read returns the error without scanning", async () => {
  let scans = 0;
  const result = await loadSessionSnapshot({
    currentRoute: sessionRoute,
    syncMessages: async () => {},
    loadBoard: async () => ({ ok: false, error: "zinn task list failed" }),
    scan: () => {
      scans += 1;
      return scanOf([]);
    },
    log: () => {},
  });

  expect(result).toEqual({ kind: "error", error: "zinn task list failed" });
  expect(scans).toBe(0);
});

test("a successful read carries the board, known mentions and their counts", async () => {
  const map = new Map([
    ["PKG-1", task("PKG-1", "Active")],
    ["PKG-2", task("PKG-2", "Archived")],
  ]);
  const known = [
    { key: "PKG-1", count: 2 },
    { key: "PKG-2", count: 1 },
  ];
  let synced = "";
  let scanned = "";
  const result = await loadSessionSnapshot({
    currentRoute: sessionRoute,
    syncMessages: async (sessionID) => {
      synced = sessionID;
    },
    loadBoard: async () => ({ ok: true, value: map }),
    scan: (sessionID) => {
      scanned = sessionID;
      return scanOf(known);
    },
    log: () => {},
  });

  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") {
    return;
  }
  expect(synced).toBe("ses_open");
  expect(scanned).toBe("ses_open");
  expect(result.snapshot.sessionID).toBe("ses_open");
  expect(result.snapshot.map).toBe(map);
  expect([...result.snapshot.activeMap.keys()]).toEqual(["PKG-1"]);
  expect(result.snapshot.known).toEqual(known);
  expect([...result.snapshot.counts]).toEqual([
    ["PKG-1", 2],
    ["PKG-2", 1],
  ]);
});

test("a failed message sync continues with the cached messages", async () => {
  const logs: string[] = [];
  const result = await loadSessionSnapshot({
    currentRoute: sessionRoute,
    syncMessages: async () => {
      throw new Error("offline");
    },
    loadBoard: async () => ({ ok: true, value: new Map() }),
    scan: () => scanOf([{ key: "PKG-9", count: 1 }]),
    log: (message) => {
      logs.push(message);
    },
  });

  expect(result.kind).toBe("ready");
  expect(logs).toEqual(["message sync failed"]);
});
