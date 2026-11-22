import type { Holder } from "./rows.ts";

export const SECTION_ROWS = 5;
// Reserve two columns for status glyphs that terminals can render wide.
export const MARKER_COLUMNS = 2;
export const PRIORITY_COLUMNS = 1;
export const RAIL_COLUMNS = 1;
export const SESSION_GLYPH = "⧗";
export const CLAIM_GLYPH: Record<Holder, string> = { mine: "◆", theirs: "◇" };
export const RUNNING_FRAMES = ["■", "□", "▪", "▫"];
export const RUNNING_INTERVAL = 300;
export const SCROLLBAR_COLUMNS = 1;
// Sidebar width minus horizontal padding and its scrollbar.
export const SLOT_COLUMNS = 42 - 2 - 2 - SCROLLBAR_COLUMNS;
export const PRIORITY_LETTER: Record<string, string | undefined> = {
  urgent: "U",
  high: "H",
  medium: "M",
  low: "L",
};
// A task row's cell for an unassigned priority, matching the CLI.
const EMPTY_PRIORITY_MARKER = "-";
export function priorityLetter(priority: string | null): string {
  if (!priority) {
    return EMPTY_PRIORITY_MARKER;
  }
  return PRIORITY_LETTER[priority] ?? "";
}
export type CurrentMark = "off" | "glyph";
export type InspectorOptions = {
  rows: 1 | 2;
  current: CurrentMark;
  renewClaims: boolean;
};
export const DEFAULT_OPTIONS: InspectorOptions = { rows: 1, current: "off", renewClaims: true };
export function readCurrentMark(value: unknown): CurrentMark {
  return value === "glyph" ? "glyph" : "off";
}
export function readRenewClaims(value: unknown): boolean {
  return value !== false;
}
export function readOptions(options: unknown): InspectorOptions {
  if (typeof options !== "object" || options === null) {
    return DEFAULT_OPTIONS;
  }
  const bag = options as Record<string, unknown>;
  return {
    rows: bag["rows"] === 2 ? 2 : 1,
    current: readCurrentMark(bag["current"]),
    renewClaims: readRenewClaims(bag["renewClaims"]),
  };
}
