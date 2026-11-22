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
  const shown = keys.filter((key) => map?.get(key) !== undefined || includeUnknown);
  let keyWidth = 0;
  for (const key of shown) {
    keyWidth = Math.max(keyWidth, key.length);
  }

  const out: PickerOption[] = [];
  for (const key of shown) {
    const summary = map?.get(key);
    const keyCell = key.padEnd(keyWidth);

    if (!summary) {
      out.push({ title: `${keyCell} | ${MISSING_GLYPH} not in store`, value: key });
      continue;
    }

    const glyph = columnGlyph(summary.column, summary.columnCategory, summary.status);
    // The CLI's `none` keyword clears the priority, so it counts as unassigned.
    const priority = summary.priority === "none" ? null : summary.priority;
    const priorityCell = taskPriorityCell(priority, { full: false });
    out.push({
      title: `${keyCell} | ${glyph} ${priorityCell.text} | ${truncate(summary.title, 64)}`,
      value: key,
    });
  }
  return out;
}
