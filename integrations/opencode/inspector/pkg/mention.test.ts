import { expect, test } from "bun:test";
import type { Ctx } from "./types.ts";
import { lastMentionExcerpt } from "./scan.ts";

const ctxWith = (messages: unknown[]): Ctx =>
  ({ data: { session: { message: { list: () => messages } } } }) as unknown as Ctx;

const user = (text: string) => ({ id: text.slice(0, 8), type: "user", text });
const assistant = (text: string) => ({
  id: text.slice(0, 8),
  type: "assistant",
  time: { completed: 1 },
  content: [{ type: "text", text }],
});
const plan = (content: string, field: "name" | "tool" = "name") => ({
  id: content.slice(0, 8),
  type: "assistant",
  time: { completed: 1 },
  content: [
    {
      type: "tool",
      [field]: "todowrite",
      state: { status: "completed", input: { todos: [{ content }] } },
    },
  ],
});
const plans = (...contents: string[]) => ({
  id: "plans",
  type: "assistant",
  time: { completed: 1 },
  content: contents.map((content) => ({
    type: "tool",
    name: "todowrite",
    state: { status: "completed", input: { todos: [{ content }] } },
  })),
});

test("finds a key in user text", () => {
  const excerpt = lastMentionExcerpt(ctxWith([user("see ZTP-1 for context")]), "s", "ZTP-1");
  expect(excerpt?.match).toBe("ZTP-1");
  expect(excerpt?.before).toBe("see ");
});

test("finds a key in assistant text", () => {
  const excerpt = lastMentionExcerpt(ctxWith([assistant("done ZTP-2 today")]), "s", "ZTP-2");
  expect(excerpt?.after).toBe(" today");
});

test("takes the newest message, not the oldest", () => {
  const excerpt = lastMentionExcerpt(
    ctxWith([user("ZTP-1 first"), assistant("ZTP-1 second")]),
    "s",
    "ZTP-1",
  );
  expect(excerpt?.after).toBe(" second");
});

test("finds a key that only exists in a todowrite plan", () => {
  const excerpt = lastMentionExcerpt(
    ctxWith([plan("finish the ZTP-3 backfill")]),
    "s",
    "ZTP-3",
  );
  expect(excerpt?.match).toBe("ZTP-3");
  expect(excerpt?.after).toBe(" backfill");
});

test("accepts a todowrite named through tool", () => {
  const excerpt = lastMentionExcerpt(
    ctxWith([plan("finish the ZTP-5 backfill", "tool")]),
    "s",
    "ZTP-5",
  );
  expect(excerpt?.match).toBe("ZTP-5");
});

test("ignores an older plan once a newer plan exists", () => {
  const messages = [plan("old ZTP-1 plan"), plan("new ZTP-2 plan")];
  expect(lastMentionExcerpt(ctxWith(messages), "s", "ZTP-1")).toBeUndefined();
});

test("uses the last plan in one message", () => {
  const messages = [plans("old ZTP-1 plan", "new ZTP-2 plan")];
  expect(lastMentionExcerpt(ctxWith(messages), "s", "ZTP-1")).toBeUndefined();
});

test("still finds text older than the latest plan", () => {
  const messages = [user("see ZTP-1 in text"), plan("new ZTP-2 plan")];
  expect(lastMentionExcerpt(ctxWith(messages), "s", "ZTP-1")?.match).toBe("ZTP-1");
});

test("returns undefined for a key that is not there", () => {
  expect(lastMentionExcerpt(ctxWith([user("nothing here")]), "s", "ZTP-9")).toBeUndefined();
});

test("skips a streaming assistant message", () => {
  const streaming = {
    id: "stream",
    type: "assistant",
    content: [{ type: "text", text: "ZTP-4 now" }],
  };
  expect(lastMentionExcerpt(ctxWith([streaming]), "s", "ZTP-4")).toBeUndefined();
});
