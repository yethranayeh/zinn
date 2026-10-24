import type { TaskWithKey } from "@zinn-dev/core";
import type { RowCell } from "./row-layout.js";
import type { PresentedTask, PresentedTaskDetail } from "../result-schemas.js";

import { column, label, task } from "@zinn-dev/core";

import { columnNameCell } from "./column-presentation.js";
import { labelNameCell } from "./label-presentation.js";
import { formatCell, formatCellSeparator, formatRows } from "./row-layout.js";
import { formatLocalTime } from "./time.js";

const EMPTY_CELL_MARKER = "-";
const LABEL_NAME_SEPARATOR = ", ";

function taskPriorityCell(
  priority: PresentedTask["priority"],
  showsFullPriority: boolean,
): RowCell {
  if (priority == null) {
    return { text: EMPTY_CELL_MARKER, style: "dim" };
  }

  const priorityInitial = priority[0]!.toUpperCase();
  return { text: showsFullPriority ? `${priorityInitial}${priority.slice(1)}` : priorityInitial };
}

/**
 * `PresentedTask` carries label names and IDs, without colors.
 * Text output looks the colors up from the label definitions instead.
 */
function getLabelColorsByName() {
  return new Map(label.getAll().map((labelMatch) => [labelMatch.name, labelMatch.color]));
}

export function presentTask(taskMatch: TaskWithKey): PresentedTask {
  const labels = task.label.getAll(taskMatch.key);
  return {
    id: taskMatch.id,
    key: taskMatch.key,
    project_id: taskMatch.project_id,
    status: taskMatch.archived_at == null ? "Active" : "Archived",
    column: column.getById(taskMatch.column_id)!.name,
    column_id: taskMatch.column_id,
    title: taskMatch.title,
    description: taskMatch.description,
    priority: taskMatch.priority,
    labels: labels.map((label) => label.name),
    label_ids: labels.map((label) => label.id),
  };
}

export function formatTaskList(
  presentedTasks: Array<PresentedTask>,
  options: { showsStatus?: boolean; showsFullPriority?: boolean; prefix?: string } = {},
) {
  const labelColorsByName = getLabelColorsByName();

  return formatRows(
    presentedTasks.map((presentedTask) => {
      const statusCells: Array<RowCell> = options.showsStatus
        ? [{ text: presentedTask.status }]
        : [];
      const hasLabels = presentedTask.labels.length > 0;
      // The last cell is never padded, so the color codes in its separator and label names do not affect column widths.
      const labelNames = presentedTask.labels
        .map((labelName) => formatCell(labelNameCell(labelName, labelColorsByName.get(labelName)!)))
        .join(LABEL_NAME_SEPARATOR);
      const labels = hasLabels ? `${formatCellSeparator()}${labelNames}` : "";

      return [
        { text: `${options.prefix ?? ""}${presentedTask.key}` },
        ...statusCells,
        columnNameCell(presentedTask.column),
        taskPriorityCell(presentedTask.priority, options.showsFullPriority ?? false),
        { text: `${presentedTask.title}${labels}` },
      ];
    }),
  );
}

export function formatTaskTimestamps(task: Pick<PresentedTaskDetail, "created_at" | "updated_at">) {
  return formatRows([
    [
      { text: `Task created at: ${formatLocalTime(task.created_at)}`, style: "dim" },
      { text: `Task updated at: ${formatLocalTime(task.updated_at)}`, style: "dim" },
    ],
  ]);
}
