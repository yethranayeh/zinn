import type { LabelColor, TaskPriority, TaskWithKey } from "@zinn-dev/core";
import type { RowCell } from "./row-layout";

import { column, label, task } from "@zinn-dev/core";

import { styleOutputText } from "./color";
import { columnNameCell } from "./column-presentation";
import { formatCellSeparator, formatRows } from "./row-layout";

export type PresentedTask = {
  key: string;
  status: "Active" | "Archived";
  column: string;
  title: string;
  description: string | null;
  priority: TaskPriority | null;
  labels: Array<string>;
};

const EMPTY_CELL_MARKER = "-";
const LABEL_NAME_SEPARATOR = ", ";

function taskPriorityCell(priority: TaskPriority | null, showsFullPriority: boolean): RowCell {
  if (priority == null) {
    return { text: EMPTY_CELL_MARKER, style: "dim" };
  }

  const priorityInitial = priority[0]!.toUpperCase();
  return { text: showsFullPriority ? `${priorityInitial}${priority.slice(1)}` : priorityInitial };
}

/**
 * `PresentedTask` carries label names only, so JSON stays a list of names.
 * Text output looks the colors up from the label definitions instead.
 */
function getLabelColorsByName() {
  return new Map(label.getAll().map((labelMatch) => [labelMatch.name, labelMatch.color]));
}

function formatLabelNames(labelNames: Array<string>, labelColorsByName: Map<string, LabelColor>) {
  return labelNames
    .map((labelName) => styleOutputText(labelColorsByName.get(labelName)!, labelName))
    .join(LABEL_NAME_SEPARATOR);
}

export function presentTask(taskMatch: TaskWithKey): PresentedTask {
  return {
    key: taskMatch.key,
    status: taskMatch.archived_at == null ? "Active" : "Archived",
    column: column.getById(taskMatch.column_id)!.name,
    title: taskMatch.title,
    description: taskMatch.description,
    priority: taskMatch.priority,
    labels: task.label.getAll(taskMatch.key).map((label) => label.name),
  };
}

export function formatTaskRow(presented: PresentedTask) {
  return formatTaskList([presented]);
}

export function formatTaskList(
  presentedTasks: Array<PresentedTask>,
  options: { showsStatus?: boolean; showsFullPriority?: boolean } = {},
) {
  const labelColorsByName = getLabelColorsByName();

  return formatRows(
    presentedTasks.map((presentedTask) => {
      const statusCells: Array<RowCell> = options.showsStatus
        ? [{ text: presentedTask.status }]
        : [];
      const hasLabels = presentedTask.labels.length > 0;
      // The last cell is never padded, so the color codes in its separator and label names do not affect column widths.
      const labels = hasLabels
        ? `${formatCellSeparator()}${formatLabelNames(presentedTask.labels, labelColorsByName)}`
        : "";

      return [
        { text: presentedTask.key },
        ...statusCells,
        columnNameCell(presentedTask.column),
        taskPriorityCell(presentedTask.priority, options.showsFullPriority ?? false),
        { text: `${presentedTask.title}${labels}` },
      ];
    }),
  );
}

export function formatTaskListWithStatus(presentedTasks: Array<PresentedTask>) {
  return formatTaskList(presentedTasks, { showsStatus: true });
}
