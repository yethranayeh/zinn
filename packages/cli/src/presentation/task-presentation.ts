import type { TaskWithKey } from "@zinn-dev/core";
import type { RowCell } from "./row-layout.js";
import type { PresentedTask, PresentedTaskDetail } from "../result-schemas.js";
import type { ColumnBoard } from "./column-presentation.js";

import { label, task } from "@zinn-dev/core";

import { columnNameCell, columnPlacement, createColumnBoard } from "./column-presentation.js";
import { labelNameCell } from "./label-presentation.js";
import { formatCell, formatCellSeparator, formatRows } from "./row-layout.js";
import { formatLocalTime } from "./time.js";

const EMPTY_CELL_MARKER = "-";
const LABEL_NAME_SEPARATOR = ", ";

export function taskPriorityCell(
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

function formatTaskLabelNames(labelNames: Array<string>, labelColorsByName: Map<string, string>) {
  return labelNames
    .map((labelName) => formatCell(labelNameCell(labelName, labelColorsByName.get(labelName)!)))
    .join(LABEL_NAME_SEPARATOR);
}

/** A task's label names on their own, colored as in a task row. */
export function formatLabelNames(labelNames: Array<string>) {
  return formatTaskLabelNames(labelNames, getLabelColorsByName());
}

export function presentTask(
  taskMatch: TaskWithKey,
  board: ColumnBoard = createColumnBoard(),
): PresentedTask {
  const labels = task.label.getAll(taskMatch.key);
  const projectColumns = board(taskMatch.project_id);
  const columnMatch = projectColumns.find((boardColumn) => boardColumn.id === taskMatch.column_id)!;
  const placement = columnPlacement(projectColumns, taskMatch.column_id);
  return {
    id: taskMatch.id,
    key: taskMatch.key,
    project_id: taskMatch.project_id,
    status: taskMatch.archived_at == null ? "Active" : "Archived",
    column: columnMatch.name,
    column_id: taskMatch.column_id,
    is_first: placement.is_first,
    is_last: placement.is_last,
    column_category: columnMatch.category ?? null,
    title: taskMatch.title,
    description: taskMatch.description,
    priority: taskMatch.priority,
    due_at: taskMatch.due_at ?? null,
    labels: labels.map((label) => label.name),
    label_ids: labels.map((label) => label.id),
    created_at: taskMatch.created_at,
    updated_at: taskMatch.updated_at,
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
      const labelNames = formatTaskLabelNames(presentedTask.labels, labelColorsByName);
      const labels = hasLabels ? `${formatCellSeparator()}${labelNames}` : "";
      const deadline =
        presentedTask.due_at == null
          ? ""
          : `${formatCellSeparator()}Due ${formatLocalTime(presentedTask.due_at, { includesSeconds: true })}`;

      return [
        { text: `${options.prefix ?? ""}${presentedTask.key}` },
        ...statusCells,
        columnNameCell(presentedTask.column, presentedTask),
        taskPriorityCell(presentedTask.priority, options.showsFullPriority ?? false),
        { text: `${presentedTask.title}${deadline}${labels}` },
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
