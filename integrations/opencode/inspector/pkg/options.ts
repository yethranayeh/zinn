export const SECTION_ROWS = 5;
// Reserve two columns for status glyphs that terminals can render wide.
export const MARKER_COLUMNS = 2;
export const PRIORITY_COLUMNS = 1;
export const RAIL_COLUMNS = 1;
export const SESSION_GLYPH = "⧗";
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
export function priorityLetter(priority: string | null): string {
  if (!priority) {
    return "";
  }
  return PRIORITY_LETTER[priority] ?? "";
}
export type CurrentMark = "off" | "glyph";
export type InspectorOptions = {
  rows: 1 | 2;
  current: CurrentMark;
};
export const DEFAULT_OPTIONS: InspectorOptions = { rows: 1, current: "off" };
export function readCurrentMark(value: unknown): CurrentMark {
  return value === "glyph" ? "glyph" : "off";
}
export function readOptions(options: unknown): InspectorOptions {
  if (typeof options !== "object" || options === null) {
    return DEFAULT_OPTIONS;
  }
  const bag = options as Record<string, unknown>;
  return { rows: bag["rows"] === 2 ? 2 : 1, current: readCurrentMark(bag["current"]) };
}
