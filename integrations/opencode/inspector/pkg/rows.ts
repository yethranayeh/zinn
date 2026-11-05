import type { Excerpt } from "./types.ts";

export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
export function truncate(text: string, max: number): string {
  const flat = flatten(text);
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}
export function firstParagraph(text: string): string {
  const block = text.split(/\n\s*\n/)[0] ?? "";
  return truncate(block, 500);
}
// Sized for the 86-column large dialog: "last: " + before + key + after.
export const EXCERPT_BEFORE = 24;
export const EXCERPT_AFTER = 40;
const KEY_CHAR = /[A-Za-z0-9_-]/;
/**
 * The last key occurrence in a flattened text, clamped on both sides.
 * One per unique mention
 */
export function excerptAround(
  text: string,
  key: string,
  before = EXCERPT_BEFORE,
  after = EXCERPT_AFTER,
): Excerpt | undefined {
  const flat = flatten(text);
  const hay = flat.toLowerCase();
  const needle = key.toLowerCase();
  let at = -1;
  let from = hay.length;

  for (;;) {
    at = hay.lastIndexOf(needle, from - 1);
    if (at === -1) {
      return undefined;
    }
    const left = at === 0 ? "" : (flat[at - 1] ?? "");
    const right = flat[at + key.length] ?? "";
    if (!KEY_CHAR.test(left) && !KEY_CHAR.test(right)) {
      break;
    }
    if (at === 0) {
      return undefined;
    }
    from = at;
  }

  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + key.length + after);
  return {
    before: `${start > 0 ? "…" : ""}${flat.slice(start, at)}`,
    match: flat.slice(at, at + key.length),
    after: `${flat.slice(at + key.length, end)}${end < flat.length ? "…" : ""}`,
  };
}
export const COLUMN_GLYPH: Record<string, string | undefined> = {
  Done: "✔",
  Blocked: "✖",
  "In Progress": "▸",
};
export function columnGlyph(column: string): string {
  return COLUMN_GLYPH[column] ?? "";
}
export type RowTone = "normal" | "done" | "created" | "blocked" | "warning";
export type DisplayRow = {
  key: string;
  title: string;
  glyph: string;
  tone: RowTone;
  unknown: boolean;
  created: boolean;
  mine: boolean;
  priority: string | null;
  labels: string[];
  column: string;
};
export function sameDisplayRow(a: DisplayRow, b: DisplayRow): boolean {
  if (a === b) {
    return true;
  }

  return (
    a.key === b.key &&
    a.title === b.title &&
    a.priority === b.priority &&
    a.column === b.column &&
    a.glyph === b.glyph &&
    a.tone === b.tone &&
    a.unknown === b.unknown &&
    a.created === b.created &&
    a.mine === b.mine &&
    sameLabels(a.labels, b.labels)
  );
}
export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
// Solid keys rows by object identity. Retain unchanged row objects.
export function stableRows(
  cache: Map<string, DisplayRow>,
  candidates: readonly DisplayRow[],
): Array<DisplayRow> {
  const out: Array<DisplayRow> = [];

  for (const candidate of candidates) {
    const previous = cache.get(candidate.key);
    const row =
      previous !== undefined && sameDisplayRow(previous, candidate) ? previous : candidate;
    cache.set(candidate.key, row);
    out.push(row);
  }

  const keep = new Set(candidates.map((candidate) => candidate.key));
  for (const key of [...cache.keys()]) {
    if (!keep.has(key)) {
      cache.delete(key);
    }
  }

  return out;
}
export function rowTone(column: string, unknown: boolean, created: boolean): RowTone {
  if (unknown) {
    return "warning";
  }
  if (created) {
    return "created";
  }
  if (column === "Done") {
    return "done";
  }
  if (column === "Blocked") {
    return "blocked";
  }
  return "normal";
}
