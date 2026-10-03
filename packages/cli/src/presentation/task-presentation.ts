import type { TaskPriority, TaskWithKey } from "@zinn-dev/core";
import type { RowCell } from "./row-layout";

import { column, task } from "@zinn-dev/core";

import { formatCell, formatRows } from "./row-layout";

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

function formatTaskPriorityMarker(priority: TaskPriority | null) {
  if (priority == null) {
    return EMPTY_CELL_MARKER;
  }

  return priority[0]!.toUpperCase();
}

function taskColumnCell(columnName: string): RowCell {
  // TODO: Derive column colors from column roles once roles exist instead of relying on names.
  if (columnName === "Backlog") {
    return { text: columnName, style: "gray" };
  }

  if (columnName === "Done") {
    return { text: columnName, style: "green" };
  }

  return { text: columnName };
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

export function formatTask(presented: PresentedTask, options: { showsStatus?: boolean } = {}) {
  const status = options.showsStatus ? ` | ${presented.status}` : "";
  const column = formatCell(taskColumnCell(presented.column));
  const hasDescription = presented.description != null && presented.description.length > 0;
  const description = hasDescription ? ` | ${presented.description}` : "";

  const priority = presented.priority == null ? "" : ` | Priority: ${presented.priority}`;
  const labelText =
    presented.labels.length === 0 ? "" : ` | Labels: ${presented.labels.join(", ")}`;

  return `${presented.key}${status} | ${column} | ${presented.title}${description}${priority}${labelText}`;
}

export function formatTaskWithStatus(presented: PresentedTask) {
  return formatTask(presented, { showsStatus: true });
}

export function formatTaskMove(presented: PresentedTask) {
  return formatTaskMoveList([presented]);
}

export function formatTaskMoveList(presentedTasks: Array<PresentedTask>) {
  return formatRows(
    presentedTasks.map((presentedTask) => [
      { text: presentedTask.key },
      taskColumnCell(presentedTask.column),
    ]),
  );
}

export function formatTaskList(
  presentedTasks: Array<PresentedTask>,
  options: { showsStatus?: boolean } = {},
) {
  return formatRows(
    presentedTasks.map((presentedTask) => {
      const statusCells: Array<RowCell> = options.showsStatus
        ? [{ text: presentedTask.status }]
        : [];
      const hasLabels = presentedTask.labels.length > 0;
      const labels = hasLabels ? ` | ${presentedTask.labels.join(", ")}` : "";

      return [
        { text: presentedTask.key },
        ...statusCells,
        taskColumnCell(presentedTask.column),
        { text: formatTaskPriorityMarker(presentedTask.priority) },
        { text: `${presentedTask.title}${labels}` },
      ];
    }),
  );
}

export function formatTaskListWithStatus(presentedTasks: Array<PresentedTask>) {
  return formatTaskList(presentedTasks, { showsStatus: true });
}
