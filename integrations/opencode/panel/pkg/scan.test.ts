import { expect, test } from "bun:test";
import { scanSession } from "./scan.ts";
test("scans completed prose and the latest plan with project-aware recency", () => {
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
const messages: any[] = [
  { type: "user", text: "please look at ZTP-1" },
  {
    type: "assistant",
    time: { completed: 1 },
    content: [
      { type: "text", text: "checking ZTP-2" },
      {
        type: "tool",
        name: "bash",
        state: { status: "completed", input: { command: "echo ZTP-9" } },
      },
      {
        type: "tool",
        name: "todowrite",
        state: { status: "completed", input: { todos: [{ content: "old ZTP-4" }] } },
      },
    ],
  },
  {
    type: "assistant",
    time: { completed: 2 },
    content: [
      {
        type: "tool",
        tool: "todowrite",
        state: {
          status: "completed",
          input: {
            todos: [{ content: "Fix ZTP-3", status: "pending" }, { content: "note NOPE-9" }],
          },
        },
      },
    ],
  },
  {
    type: "assistant",
    time: {},
    content: [
      { type: "text", text: "streaming ZTP-7" },
      {
        type: "tool",
        name: "todowrite",
        state: { status: "running", input: { todos: [{ content: "ZTP-8" }] } },
      },
    ],
  },
];
const ctx = { data: { session: { message: { list: () => messages } } } } as any;
const scan = scanSession(ctx, "ses_check", map as any);
const known = scan.known.map((m) => m.key);
const unknown = scan.unknown.map((m) => m.key);
const all = [...known, ...unknown];
function check(label: string, ok: boolean, detail = "") {
  expect(ok, `${label} ${detail}`).toBe(true);
}
check("a key only in the latest plan is a mention", all.includes("ZTP-3"), all.join(","));
check("the plan outranks older prose (recency)", known[0] === "ZTP-3", `known=${known.join(",")}`);
check("text mentions still work", all.includes("ZTP-1") && all.includes("ZTP-2"), all.join(","));
check("a superseded plan is history, not current", !all.includes("ZTP-4"), all.join(","));
check("another tool's input is never scanned", !all.includes("ZTP-9"), all.join(","));
check("streaming text stays out (unchanged behaviour)", !all.includes("ZTP-7"), all.join(","));
check("a still-running plan is not the checklist yet", !all.includes("ZTP-8"), all.join(","));
check("a key with an unknown project prefix is not surfaced", !all.includes("NOPE-9"), all.join(","));
check("one key is counted once per occurrence", scan.known.find((m) => m.key === "ZTP-1")?.count === 1, "");
check("an unloadable map yields an empty scan shape", (() => {
  const empty = scanSession(ctx, "ses_check", new Map() as any);
  return empty.known.length === 0 && empty.unknown.length === 0;
})(), "");

});
