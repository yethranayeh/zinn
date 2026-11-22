import type { TaskSummary } from "./types.ts";

import { MISSING_GLYPH, columnGlyph, taskPriorityCell } from "./presentation.ts";
import { truncate } from "./rows.ts";

export type PickerOption = {
  title: string;
  description?: string;
  value: string;
};
export function pickerOptions(
  keys: readonly string[],
  map: Map<string, TaskSummary> | undefined,
  includeUnknown: boolean,
): PickerOption[] {
  const out: PickerOption[] = [];
  for (const key of keys) {
    const summary = map?.get(key);

    if (!summary) {
      if (!includeUnknown) {
        continue;
      }
      out.push({ title: `${key} ${MISSING_GLYPH} not in store`, value: key });
      continue;
    }

    const glyph = columnGlyph(summary.column, summary.columnCategory, summary.status);
    const option: PickerOption = {
      title: `${key} ${glyph} ${truncate(summary.title, 64)}`,
      value: key,
    };
    const priority = summary.priority;
    if (priority !== null && priority.length > 0 && priority !== "none") {
      option.description = taskPriorityCell(priority, { full: false }).text;
    }
    out.push(option);
  }
  return out;
}
