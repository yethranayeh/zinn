import type { TaskPriority, TaskWithKey } from "@zinn-dev/core";

import { column, task } from "@zinn-dev/core";

import { formatDescriptionPreview } from "./description-presentation";
import { styleOutputText } from "./color";

export type PresentedTask = {
  key: string;
  status: "Active" | "Archived";
  column: string;
  title: string;
  description: string | null;
  priority: TaskPriority | null;
  labels: Array<string>;
};

function formatTaskPriorityMarker(priority: TaskPriority | null) {
  if (priority == null) {
    return "-";
  }

  return priority[0]!.toUpperCase();
}

export function formatTaskColumn(columnName: string, width = columnName.length) {
  const paddedColumnName = columnName.padEnd(width);

  // TODO: Derive column colors from column roles once roles exist instead of relying on names.
  if (columnName === "Backlog") {
    return styleOutputText("gray", paddedColumnName);
  }

  if (columnName === "Done") {
    return styleOutputText("green", paddedColumnName);
  }

  return paddedColumnName;
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
  const column = formatTaskColumn(presented.column);
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

export function formatTaskMove(presented: PresentedTask, keyWidth = presented.key.length) {
  return `${presented.key.padEnd(keyWidth)} | ${formatTaskColumn(presented.column)}`;
}

export function formatTaskMoveList(presentedTasks: Array<PresentedTask>) {
  const longestKeyLength = presentedTasks.reduce(
    (previousLength, currentTask) => Math.max(previousLength, currentTask.key.length),
    0,
  );

  return presentedTasks
    .map((presentedTask) => formatTaskMove(presentedTask, longestKeyLength))
    .join("\n");
}

export function formatTaskList(
  presentedTasks: Array<PresentedTask>,
  options: { showsStatus?: boolean } = {},
) {
  const longestKeyLength = presentedTasks.reduce(
    (previousLength, currentTask) => Math.max(previousLength, currentTask.key.length),
    0,
  );
  const longestColumnNameLength = presentedTasks.reduce(
    (previousLength, currentTask) => Math.max(previousLength, currentTask.column.length),
    0,
  );
  const longestStatusLength = presentedTasks.reduce(
    (previousLength, currentTask) => Math.max(previousLength, currentTask.status.length),
    0,
  );

  return presentedTasks
    .map((presentedTask) => {
      const status = options.showsStatus
        ? ` | ${presentedTask.status.padEnd(longestStatusLength)}`
        : "";
      const descriptionPreview = formatDescriptionPreview(presentedTask.description);
      const hasDescriptionPreview = descriptionPreview.length > 0;
      const description = hasDescriptionPreview ? ` | ${descriptionPreview}` : "";
      const priority = formatTaskPriorityMarker(presentedTask.priority);
      const column = formatTaskColumn(presentedTask.column, longestColumnNameLength);

      return `${presentedTask.key.padEnd(longestKeyLength)}${status} | ${column} | ${priority} | ${presentedTask.title}${description}`;
    })
    .join("\n");
}

export function formatTaskListWithStatus(presentedTasks: Array<PresentedTask>) {
  return formatTaskList(presentedTasks, { showsStatus: true });
}
