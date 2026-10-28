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
  count: number;
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
    a.count === b.count &&
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
