import { expect, test } from "bun:test";
import { excerptAround, EXCERPT_AFTER, EXCERPT_BEFORE } from "./rows.ts";

test("clamps both sides and keeps the key", () => {
  const text =
    "lorem ipsum dolor sit amet ZOPC-41 consectetur adipiscing elit sed do eiusmod tempor incididunt";
  const excerpt = excerptAround(text, "ZOPC-41");
  expect(excerpt).toBeDefined();
  expect(excerpt!.match).toBe("ZOPC-41");
  expect(excerpt!.before.startsWith("…")).toBe(true);
  expect(excerpt!.after.endsWith("…")).toBe(true);
  expect(excerpt!.before.length).toBeLessThanOrEqual(EXCERPT_BEFORE + 1);
  expect(excerpt!.after.length).toBeLessThanOrEqual(EXCERPT_AFTER + 1);
});

test("takes the last occurrence, not the first", () => {
  const excerpt = excerptAround("ZTP-1 first, then ZTP-2, then ZTP-1 last", "ZTP-1", 6, 6);
  expect(excerpt!.after).toContain("last");
});

test("no ellipsis on a side that was not cut", () => {
  const excerpt = excerptAround("see ZTP-1 here", "ZTP-1");
  expect(excerpt!.before).toBe("see ");
  expect(excerpt!.after).toBe(" here");
});

test("ignores a key embedded in a longer token", () => {
  expect(excerptAround("XZTP-1 and ZTP-10", "ZTP-1")).toBeUndefined();
});

test("treats an underscore as part of a token", () => {
  expect(excerptAround("ZTP-1_report.md", "ZTP-1")).toBeUndefined();
});

test("matches case-insensitively and preserves the source case", () => {
  const excerpt = excerptAround("done zopc-41 today", "ZOPC-41");
  expect(excerpt!.match).toBe("zopc-41");
});

test("flattens newlines into one line", () => {
  const excerpt = excerptAround("first line\nsecond ZTP-1 line", "ZTP-1");
  expect(excerpt!.before).toBe("first line second ");
  expect(excerpt!.after).toBe(" line");
});
