import { LABEL_HEX } from "./data.ts";

export const CATEGORY_GLYPH: Record<string, string | undefined> = {
  backlog: "○",
  todo: "○",
  in_progress: "◐",
  review: "◑",
  done: "●",
  cancelled: "✕",
};
export const NAME_GLYPH: Record<string, string | undefined> = {
  Backlog: "○",
  TODO: "○",
  "In Progress": "◐",
  Review: "◑",
  Blocked: "⊘",
  Done: "●",
  Cancelled: "✕",
};
const ARCHIVED_GLYPH = "▪";
const UNKNOWN_GLYPH = "·";
export const MISSING_GLYPH = "✗";
const EMPTY_PRIORITY_MARKER = "-";
const CHIP_PRIORITY = "urgent";
export const CHIP_PAD = 2;
const PRIORITY_COLOR: Record<string, string> = {
  urgent: LABEL_HEX["red"],
  high: LABEL_HEX["yellow"],
  medium: LABEL_HEX["blue"],
  low: LABEL_HEX["gray"],
};
/** The category first, then the column name when the CLI sends no category. */
export function columnGlyph(column: string, category: string | null, status = "Active"): string {
  if (status === "Archived") {
    return ARCHIVED_GLYPH;
  }

  const byCategory = category === null ? undefined : CATEGORY_GLYPH[category];
  if (byCategory !== undefined) {
    return byCategory;
  }

  if (category === null) {
    return NAME_GLYPH[column] ?? UNKNOWN_GLYPH;
  }

  return UNKNOWN_GLYPH;
}
/** Backlog and todo keep the plain rail instead of a state glyph. */
export function isRestingColumn(column: string, category: string | null): boolean {
  if (category === null) {
    return column === "Backlog" || column === "TODO";
  }
  return category === "backlog" || category === "todo";
}
export type PriorityCell = {
  text: string;
  color: string | null;
  chip: boolean;
};
/** A priority as the CLI presents it: the initial letter in a compact cell, the word when full. */
export function taskPriorityCell(
  priority: string | null,
  options: { full: boolean },
): PriorityCell {
  if (!priority) {
    return { text: EMPTY_PRIORITY_MARKER, color: null, chip: false };
  }

  const initial = priority[0]!.toUpperCase();
  return {
    text: options.full ? `${initial}${priority.slice(1)}` : initial,
    color: PRIORITY_COLOR[priority] ?? null,
    chip: priority === CHIP_PRIORITY,
  };
}
/**
 * The two-row meta line leaves an unassigned priority out on purpose. That line already
 * separates the column, priority and labels, so a lone `-` would read as another separator.
 * The compact row keeps the marker because it reserves a cell for it.
 */
export function taskPriorityMeta(priority: string | null): PriorityCell | null {
  if (!priority) {
    return null;
  }
  return taskPriorityCell(priority, { full: true });
}
