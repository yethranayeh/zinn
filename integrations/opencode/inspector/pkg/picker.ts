import type { TaskSummary } from "./types.ts";

import { MISSING_GLYPH, columnGlyph, taskPriorityCell } from "./presentation.ts";
import { truncate } from "./rows.ts";

export type PickerOption = {
  title: string;
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
    // The CLI's `none` keyword clears the priority, so it counts as unassigned.
    const priority = summary.priority === "none" ? null : summary.priority;
    const priorityCell = taskPriorityCell(priority, { full: false });
    out.push({
      title: `${key} ${glyph} ${priorityCell.text} ${truncate(summary.title, 64)}`,
      value: key,
    });
  }
  return out;
}
