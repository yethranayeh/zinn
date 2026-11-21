import { expect, test } from "bun:test";
import { claimHolder, columnGlyph, rowTone, sameDisplayRow, stableRows } from "./rows.ts";
type Row = Parameters<typeof stableRows>[1][number];
type Claim = NonNullable<Row["claim"]>;
const claim = (over: Partial<Claim> = {}): Claim => ({
  state: "live",
  sessionId: "ses_root",
  threadId: "ses_child",
  expiresAt: 1_800_000_000_000,
  ...over,
});
const row = (over: Partial<Row> = {}): Row => ({
  key: "ZTP-1",
  title: "Fix the calibration",
  glyph: "▸",
  tone: "normal",
  unknown: false,
  created: false,
  mine: false,
  claim: null,
  holder: null,
  priority: "high",
  labels: ["spike", "ui"],
  column: "In Progress",
  category: "in_progress",
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
    ["category", { category: "done" }],
    ["glyph", { glyph: "✔" }],
    ["tone", { tone: "done" }],
    ["unknown", { unknown: true }],
    ["created", { created: true }],
    ["mine", { mine: true }],
    ["claim", { claim: claim() }],
    ["claim state", { claim: claim({ state: "expired" }) }],
    ["claim expiry", { claim: claim({ expiresAt: 1_800_000_000_001 }) }],
    ["holder", { holder: "mine" }],
  ];
  for (const [name, patch] of fields) {
    check(`a changed ${name} compares unequal`, !sameDisplayRow(base, { ...base, ...patch }), "");
  }
  check("labels compare element-wise, not by reference", sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["a", "b"] })), "");
  check("a shorter labels list compares unequal", !sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["a"] })), "");
  check("labels in a different order compare unequal (the panel renders the order)", !sameDisplayRow(row({ labels: ["a", "b"] }), row({ labels: ["b", "a"] })), "");
  check("a rebuilt claim with the same fields compares equal", sameDisplayRow(row({ claim: claim() }), row({ claim: claim() })), "");
  check("a changed claim expiry compares unequal", !sameDisplayRow(row({ claim: claim() }), row({ claim: claim({ expiresAt: 1_800_000_000_001 }) })), "");
  check("a changed claim session compares unequal", !sameDisplayRow(row({ claim: claim() }), row({ claim: claim({ sessionId: "ses_other" }) })), "");
  check("a changed claim thread compares unequal", !sameDisplayRow(row({ claim: claim() }), row({ claim: claim({ threadId: "ses_other" }) })), "");
  check("a null claim and a claim compare unequal", !sameDisplayRow(row(), row({ claim: claim() })), "");
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
    else if (value === null) {
      mutated[key] = {} as never;
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
test("reads the claim holder from the conversation family", () => {
  const now = 1_799_999_999_000;
  const family = new Set(["ses_root", "ses_child"]);
  check("no claim has no holder", claimHolder(null, family, now) === null, "");
  check("an expired claim by state has no holder", claimHolder(claim({ state: "expired" }), family, now) === null, "");
  check("a claim past its expiry has no holder", claimHolder(claim({ expiresAt: now - 1 }), family, now) === null, "");
  check("a claim exactly at its expiry has no holder", claimHolder(claim({ expiresAt: now }), family, now) === null, "");
  check("a claim with no expiry reads its live state", claimHolder(claim({ expiresAt: null }), family, now) === "mine", "");
  check("a live claim on this session is mine", claimHolder(claim({ sessionId: "ses_root", threadId: null }), family, now) === "mine", "");
  check("a live claim on this family's thread is mine", claimHolder(claim({ sessionId: null, threadId: "ses_child" }), family, now) === "mine", "");
  check("a live claim with ids outside the family is theirs", claimHolder(claim({ sessionId: "ses_other", threadId: "ses_other_child" }), family, now) === "theirs", "");
  check("a live claim with no identity is theirs", claimHolder(claim({ sessionId: null, threadId: null }), family, now) === "theirs", "");
});
test("reads the done treatment from the column category", () => {
  check("a renamed done column keeps the done tone", rowTone("Shipped", "done", false, false) === "done", "");
  check("a renamed done column keeps the done glyph", columnGlyph("Shipped", "done") === "✔", "");
  check("a Done-named column with another category keeps the normal tone", rowTone("Done", "review", false, false) === "normal", "");
  check("a Done-named column with another category gets no done glyph", columnGlyph("Done", "review") === "", "");
  check("a cancelled column keeps the normal tone", rowTone("Dropped", "cancelled", false, false) === "normal", "");
  check("a cancelled column gets no done glyph", columnGlyph("Dropped", "cancelled") === "", "");
  check("a missing category falls back to the Done name for the tone", rowTone("Done", null, false, false) === "done", "");
  check("a missing category falls back to the Done name for the glyph", columnGlyph("Done", null) === "✔", "");
  check("a missing category leaves other names alone", rowTone("Shipped", null, false, false) === "normal" && columnGlyph("Shipped", null) === "", "");
  check("other glyphs still follow the column name", columnGlyph("Blocked", "backlog") === "✖" && columnGlyph("In Progress", "in_progress") === "▸", "");
});
