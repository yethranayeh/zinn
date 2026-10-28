import { expect, test } from "bun:test";
import { shouldReadBoard } from "./data.ts";
import { scanSession } from "./scan.ts";
type ScanCache = {
  byID: Map<string, unknown>;
  computes: number;
};
const summary = (key: string) => ({
  key,
  title: key,
  status: "Active",
  column: "TODO",
  priority: null,
  labels: [],
});
const map = new Map([
  ["ZTP-1", summary("ZTP-1")],
  ["ZTP-3", summary("ZTP-3")],
]);
function check(label: string, ok: boolean, detail = "") {
  expect(ok, `${label} ${detail}`).toBe(true);
}
function harness(initial: any[]) {
  let messages = initial;
  const ctx = { data: { session: { message: { list: () => messages } } } } as any;
  return {
    ctx,
    set(next: any[]) {
      messages = next;
    },
    get messages() {
      return messages;
    },
    scan(cache?: ScanCache) {
      return scanSession(ctx, "ses_cache", map as any, cache as any);
    },
  };
}
const newCache = (): ScanCache => ({ byID: new Map(), computes: 0 });
const shape = (scan: ReturnType<typeof scanSession>) => ({
  known: scan.known,
  unknown: scan.unknown,
  tokens: scan.tokens,
  textParts: scan.textParts,
  streamingParts: scan.streamingParts,
  zinnCommands: scan.zinnCommands,
});
test("reuses completed messages and counts CLI invocations", () => {
  const h = harness([
    { id: "m1", type: "user", text: "please look at ZTP-1 and ZTP-2" },
    {
      id: "m2",
      type: "assistant",
      time: { completed: 1 },
      content: [
        { type: "text", text: "checking ZTP-2" },
        {
          type: "tool",
          name: "bash",
          state: { status: "completed", input: { command: "zinn task view ZTP-2 --json" } },
        },
        {
          type: "tool",
          name: "bash",
          state: { status: "completed", input: { command: "cat README.md" } },
        },
      ],
    },
    {
      id: "m3",
      type: "assistant",
      time: { completed: 2 },
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "completed", input: { todos: [{ content: "Fix ZTP-3" }] } },
        },
      ],
    },
  ]);
  const cache = newCache();
  const cold = h.scan(cache);
  const coldComputes = cache.computes;
  const warm = h.scan(cache);
  const warmComputes = cache.computes - coldComputes;
  check("a cold scan extracts every message once", coldComputes === 3, `computes=${coldComputes}`);
  check("a warm scan extracts nothing", warmComputes === 0, `delta=${warmComputes}`);
  check("cold and warm produce the same scan", JSON.stringify(shape(cold)) === JSON.stringify(shape(warm)), `${JSON.stringify(shape(cold))} vs ${JSON.stringify(shape(warm))}`);
  check("the fixture really does surface two known keys", cold.known.map((m) => m.key).join(",") === "ZTP-3,ZTP-1", cold.known.map((m) => m.key).join(","));
  check("a zinn shell part is counted once", cold.zinnCommands === 1, `zinnCommands=${cold.zinnCommands}`);
  check("a command that only mentions the name is not a zinn invocation", cold.zinnCommands !== 2, `zinnCommands=${cold.zinnCommands}`);
});
test("extracts only newly appended messages", () => {
  const first = [
    { id: "a1", type: "user", text: "look at ZTP-1" },
    {
      id: "a2",
      type: "assistant",
      time: { completed: 1 },
      content: [{ type: "text", text: "checking ZTP-2" }],
    },
  ];
  const h = harness(first);
  const cache = newCache();
  const before = h.scan(cache);
  const computesBefore = cache.computes;
  h.set([...first, { id: "a3", type: "user", text: "and ZTP-1 again" }]);
  const after = h.scan(cache);
  const delta = cache.computes - computesBefore;
  check("an appended message is the only one extracted", delta === 1, `delta=${delta}`);
  check("the appended message changes the output", after.tokens === before.tokens && after.known[0]?.count === 2, JSON.stringify(after.known));
  check("the appended message is now the most recent mention", after.known[0]?.key === "ZTP-1", after.known.map((m) => m.key).join(","));
  check("the earlier messages were not recomputed", after.tokens === 2 && after.known.length === 1 && after.unknown.length === 1, `tokens=${after.tokens}`);
});
test("recomputes streaming messages when completed", () => {
  const streaming = {
    id: "s2",
    type: "assistant",
    time: {},
    content: [{ type: "text", text: "streaming ZTP-7" }],
  };
  const h = harness([{ id: "s1", type: "user", text: "look at ZTP-1" }, streaming]);
  const cache = newCache();
  const open = h.scan(cache);
  const afterOpen = cache.computes;
  const again = h.scan(cache);
  const openDelta = cache.computes - afterOpen;
  check("an open assistant message is not cached", openDelta === 1, `delta=${openDelta}`);
  check("open text is counted as streaming", open.streamingParts === 1 && again.streamingParts === 1, `streaming=${open.streamingParts}`);
  check("open text contributes no keys", !open.unknown.some((m) => m.key === "ZTP-7"), open.unknown.map((m) => m.key).join(","));
  streaming.time = { completed: 9 } as never;
  const beforeClose = cache.computes;
  const closed = h.scan(cache);
  const closedDelta = cache.computes - beforeClose;
  check("completion recomputes the message once", closedDelta === 1, `delta=${closedDelta}`);
  check("completed text now contributes its keys", closed.unknown.some((m) => m.key === "ZTP-7"), closed.unknown.map((m) => m.key).join(","));
  check("completion clears the streaming count", closed.streamingParts === 0, `streaming=${closed.streamingParts}`);
  const beforeStable = cache.computes;
  h.scan(cache);
  check("the completed message is cached from then on", cache.computes === beforeStable, `delta=${cache.computes - beforeStable}`);
});
test("uses only the latest completed plan", () => {
  const h = harness([
    { id: "p1", type: "user", text: "hello ZTP-1" },
    {
      id: "p2",
      type: "assistant",
      time: { completed: 1 },
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "completed", input: { todos: [{ content: "old ZTP-4" }] } },
        },
      ],
    },
    {
      id: "p3",
      type: "assistant",
      time: { completed: 2 },
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "running", input: { todos: [{ content: "running ZTP-6" }] } },
        },
        {
          type: "tool",
          tool: "todowrite",
          state: { status: "completed", input: { todos: [{ content: "new ZTP-9" }] } },
        },
      ],
    },
  ]);
  const cache = newCache();
  const scan = h.scan(cache);
  const all = [...scan.known, ...scan.unknown].map((m) => m.key);
  check("the latest completed plan is a mention", all.includes("ZTP-9"), all.join(","));
  check("a superseded plan is history", !all.includes("ZTP-4"), all.join(","));
  check("a still-running plan is not the checklist", !all.includes("ZTP-6"), all.join(","));
  check("the plan is the newest mention", scan.unknown[0]?.key === "ZTP-9", scan.unknown.map((m) => m.key).join(","));
  const warm = h.scan(cache);
  check("a warm scan keeps the same plan answer", JSON.stringify(shape(scan)) === JSON.stringify(shape(warm)), "");
});
test("rescans messages without stable identifiers", () => {
  const h = harness([
    { type: "user", text: "look at ZTP-1" },
    {
      type: "assistant",
      time: { completed: 1 },
      content: [{ type: "text", text: "checking ZTP-2" }],
    },
  ]);
  const cache = newCache();
  const cold = h.scan(cache);
  const first = cache.computes;
  const warm = h.scan(cache);
  check("an id-less message is never cached", cache.computes - first === 2, `delta=${cache.computes - first}`);
  check("an id-less transcript still scans identically", JSON.stringify(shape(cold)) === JSON.stringify(shape(warm)), "");
});
test("refreshes the board for mutations, compaction and expiry", () => {
  const table: Array<[
    string,
    Parameters<typeof shouldReadBoard>[0],
    boolean
  ]> = [
    [
      "a forced refresh always reads",
      { force: true, zinnTotal: 4, lastReadZinn: 4, msSinceRead: 1, ttl: 60000 },
      true,
    ],
    [
      "a quiet turn within the TTL skips",
      { force: false, zinnTotal: 4, lastReadZinn: 4, msSinceRead: 1000, ttl: 60000 },
      false,
    ],
    [
      "a quiet turn past the TTL reads (backstop)",
      { force: false, zinnTotal: 4, lastReadZinn: 4, msSinceRead: 60001, ttl: 60000 },
      true,
    ],
    [
      "the TTL boundary itself does not read yet",
      { force: false, zinnTotal: 4, lastReadZinn: 4, msSinceRead: 60000, ttl: 60000 },
      false,
    ],
    [
      "a zinn command this turn reads",
      { force: false, zinnTotal: 5, lastReadZinn: 4, msSinceRead: 1000, ttl: 60000 },
      true,
    ],
    [
      "a transcript that shrank reads (compaction)",
      { force: false, zinnTotal: 2, lastReadZinn: 4, msSinceRead: 1000, ttl: 60000 },
      true,
    ],
    [
      "a never-read board reads",
      {
        force: false,
        zinnTotal: 0,
        lastReadZinn: 0,
        msSinceRead: Number.MAX_SAFE_INTEGER,
        ttl: 60000,
      },
      true,
    ],
  ];
  for (const [label, input, want] of table) {
    const got = shouldReadBoard(input);
    check(`shouldReadBoard: ${label}`, got === want, `got=${got}`);
  }
});
