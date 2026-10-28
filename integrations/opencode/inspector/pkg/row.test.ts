import { expect, test } from "bun:test";
import { sameDisplayRow, stableRows } from "./rows.ts";
type Row = Parameters<typeof stableRows>[1][number];
const row = (over: Partial<Row> = {}): Row => ({
  key: "ZTP-1",
  title: "Fix the calibration",
  glyph: "▸",
  tone: "normal",
  unknown: false,
  created: false,
  mine: false,
  priority: "high",
  labels: ["spike", "ui"],
  column: "In Progress",
  ...over,
});
function check(label: string, ok: boolean, detail = "") {
  expect(ok, `${label} ${detail}`).toBe(true);
}
test("compares every visible row value", () => {
  const base = row();
  check("identical rows compare equal", sameDisplayRow(base, { ...base, labels: [...base.labels] }), "");
  check("the same object compares equal (fast path)", sameDisplayRow(base, base), "");
  const fields: Array<[
    string,
    Partial<Row>
  ]> = [
    ["key", { key: "ZTP-2" }],
    ["title", { title: "something else" }],
    ["priority", { priority: "urgent" }],
    ["column", { column: "Done" }],
    ["glyph", { glyph: "✔" }],
    ["tone", { tone: "done" }],
    ["unknown", { unknown: true }],
    ["created", { created: true }],
    ["mine", { mine: true }],
  ];
  for (const [name, patch] of fields) {
    check(`a changed ${name} compares unequal`, !sameDisplayRow(base, { ...base, ...patch }), "");
  }
  check("labels compare element-wise, not by reference", sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["a", "b"] })), "");
  check("a shorter labels list compares unequal", !sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["a"] })), "");
  check("labels in a different order compare unequal (the panel renders the order)", !sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["b", "a"] })), "");
});
test("retains unchanged row identity and prunes removed keys", () => {
  const cache = new Map<string, Row>();
  const first = stableRows(cache, [row(), row({ key: "ZTP-2", column: "TODO" })]);
  check("a new array is returned (only the elements are reused)", Array.isArray(first) && first.length === 2, "");
  const second = stableRows(cache, [row(), row({ key: "ZTP-2", column: "TODO" })]);
  check("an unchanged row reuses its object (same reference)", second[0] === first[0], "");
  check("the whole unchanged section is reused", second[1] === first[1], "");
  check("the returned array itself is always new", second !== first, "");
  const third = stableRows(cache, [
    row({ labels: ["spike", "ui"] }),
    row({ key: "ZTP-2", column: "TODO" }),
  ]);
  check("a rebuilt labels array with the same contents is equal", third[0] === first[0], "");
  const fourth = stableRows(cache, [
    row(),
    row({ key: "ZTP-2", column: "Done", glyph: "✔", tone: "done" }),
  ]);
  check("an unchanged neighbour keeps its object when another row changes", fourth[0] === first[0], "");
  check("the changed row is replaced", fourth[1] !== first[1], "");
  check("the changed row carries the new value", fourth[1]?.column === "Done", "");
  const fifth = stableRows(cache, [
    row({ mine: true }),
    row({ key: "ZTP-2", column: "Done", glyph: "✔", tone: "done" }),
  ]);
  check("a flipped `mine` replaces that row", fifth[0] !== first[0] && fifth[0]?.mine === true, "");
  const before = cache.size;
  const sixth = stableRows(cache, [row({ mine: true })]);
  check("the cache prunes a key that left the section", cache.size === 1 && before === 2, `size=${cache.size}`);
  check("the remainder is still the live object", sixth[0] === fifth[0], "");
  const swapCache = new Map<string, Row>();
  stableRows(swapCache, [row({ key: "A-1" }), row({ key: "A-2" })]);
  stableRows(swapCache, [row({ key: "A-2" }), row({ key: "A-3" })]);
  check("a same-length key swap still prunes the dropped key", swapCache.size === 2 && !swapCache.has("A-1") && swapCache.has("A-3"), `keys=${[...swapCache.keys()].join(",")}`);
  const empty = stableRows(swapCache, []);
  check("an empty section returns no rows and empties the cache", empty.length === 0 && swapCache.size === 0, "");
});
test("detects changes to every field defined by a row", () => {
  const base = row();
  const keys = Object.keys(base) as Array<keyof Row>;
  let missed: string[] = [];
  for (const key of keys) {
    const mutated: Row = { ...base };
    const value = base[key];
    if (typeof value === "string") {
      mutated[key] = `${value}x` as never;
    }
    else if (typeof value === "number") {
      mutated[key] = (value + 1) as never;
    }
    else if (typeof value === "boolean") {
      mutated[key] = !value as never;
    }
    else if (Array.isArray(value)) {
      mutated[key] = ["other"] as never;
    }
    else {
      continue;
    }
    if (sameDisplayRow(base, mutated)) {
      missed.push(String(key));
    }
  }
  check("every DisplayRow field participates in the comparison", missed.length === 0, `missed=${missed.join(",")}`);
});
