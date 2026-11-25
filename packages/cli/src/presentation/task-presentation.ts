import type { TaskSearchMatch, TaskWithKey } from "@zinn-dev/core";
import type { RowCell } from "./row-layout.js";
import type { PresentedTask, PresentedTaskDetail } from "../result-schemas.js";
import type { ColumnBoard } from "./column-presentation.js";

import { label, task } from "@zinn-dev/core";

import { columnNameCell, columnPlacement, createColumnBoard } from "./column-presentation.js";
import { labelNameCell } from "./label-presentation.js";
import { formatCell, formatCellSeparator, formatRows } from "./row-layout.js";
import { formatLocalTime } from "./time.js";
import { formatActorLabel } from "./activity-presentation.js";
import { styleOutputText } from "./color.js";

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
export function getLabelColorsByName() {
  return new Map(label.getAll().map((labelMatch) => [labelMatch.name, labelMatch.color]));
}

export function formatLabelNames(
  labelNames: Array<string>,
  labelColorsByName: ReadonlyMap<string, string>,
) {
  return labelNames
    .map((labelName) => formatCell(labelNameCell(labelName, labelColorsByName.get(labelName)!)))
    .join(LABEL_NAME_SEPARATOR);
}

/** Shapes many tasks with one label read for all of them */
export function presentTasks(
  taskMatches: ReadonlyArray<TaskWithKey>,
  board: ColumnBoard = createColumnBoard(),
): Array<PresentedTask> {
  const labelsByTaskId = task.label.getAllByTaskIds(taskMatches.map((taskMatch) => taskMatch.id));

  return taskMatches.map((taskMatch) => {
    const labels = labelsByTaskId.get(taskMatch.id)!;
    const projectColumns = board(taskMatch.project_id);
    const columnMatch = projectColumns.find(
      (boardColumn) => boardColumn.id === taskMatch.column_id,
    )!;
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
      claim: presentClaim(taskMatch.claim),
    };
  });
}

export function presentTask(taskMatch: TaskWithKey, board?: ColumnBoard): PresentedTask {
  return presentTasks([taskMatch], board)[0]!;
}

export function presentTaskSearchResults(
  taskMatches: TaskWithKey[],
  matchesByTaskId: ReadonlyMap<string, TaskSearchMatch[]> | undefined,
): Array<PresentedTask & { matches?: TaskSearchMatch[] }> {
  const tasks = presentTasks(taskMatches);
  if (matchesByTaskId === undefined) {
    return tasks;
  }
  return tasks.map((task) => ({ ...task, matches: matchesByTaskId.get(task.id)! }));
}

function presentClaim(claim: TaskWithKey["claim"]): PresentedTask["claim"] {
  if (claim == null) {
    return null;
  }

  return {
    state: claim.state,
    actor_kind: claim.actor_kind,
    actor_name: claim.actor_name,
    actor_session_id: claim.actor_session_id,
    actor_thread_id: claim.actor_thread_id,
    claimed_at: claim.claimed_at,
    renewed_at: claim.renewed_at,
    worked_at: claim.worked_at,
    lease_ms: claim.lease_ms,
    expires_at: claim.expires_at,
  };
}

/** Who holds the claim, and when its lease ends or ended when `showsExpiry` is set */
function formatClaim(claim: NonNullable<PresentedTask["claim"]>, showsExpiry: boolean) {
  const holder = formatActorLabel(claim);

  if (!showsExpiry) {
    return `Claimed by ${holder}`;
  }

  const expiresAt = formatLocalTime(claim.expires_at, { includesSeconds: true });
  return claim.state === "live"
    ? `Claimed by ${holder} until ${expiresAt}`
    : `Claim by ${holder} expired at ${expiresAt}`;
}

const SEARCH_SOURCE_LABELS = { key: "Task key", title: "Title", description: "Description" };

function formatSearchExcerpt(match: TaskSearchMatch) {
  const source =
    match.field === "comment" ? `Comment ${match.comment_key}` : SEARCH_SOURCE_LABELS[match.field];
  // Render stored control characters without interpreting them as terminal commands
  const points = Array.from(match.snippet.replace(/\p{Cc}/gu, "�"));
  let snippet = "";
  let offset = 0;
  for (const [start, end] of match.highlights) {
    snippet += points.slice(offset, start).join("");
    snippet += styleOutputText(["bold", "yellow"], points.slice(start, end).join(""));
    offset = end;
  }
  snippet += points.slice(offset).join("");
  return `\n  ${source}${formatCellSeparator()}${snippet}`;
}

export function formatTaskList(
  presentedTasks: Array<PresentedTask & { matches?: TaskSearchMatch[] }>,
  options: {
    showsStatus?: boolean;
    showsFullPriority?: boolean;
    prefix?: string;
    labelColorsByName?: ReadonlyMap<string, string>;
    /** Shows an expired claim too, and when each claim's lease ends */
    showsClaimDetail?: boolean;
  } = {},
) {
  const labelColorsByName = options.labelColorsByName ?? getLabelColorsByName();

  return formatRows(
    presentedTasks.map((presentedTask) => {
      const statusCells: Array<RowCell> = options.showsStatus
        ? [{ text: presentedTask.status }]
        : [];
      const hasLabels = presentedTask.labels.length > 0;
      // The last cell is never padded, so the color codes in its separator and label names do not affect column widths.
      const labelNames = formatLabelNames(presentedTask.labels, labelColorsByName);
      const labels = hasLabels ? `${formatCellSeparator()}${labelNames}` : "";
      const deadline =
        presentedTask.due_at == null
          ? ""
          : `${formatCellSeparator()}Due ${formatLocalTime(presentedTask.due_at, { includesSeconds: true })}`;
      const showsClaimDetail = options.showsClaimDetail ?? false;
      const claim = presentedTask.claim;
      const showsClaim = claim != null && (claim.state === "live" || showsClaimDetail);
      const claimText = showsClaim
        ? `${formatCellSeparator()}${formatClaim(claim, showsClaimDetail)}`
        : "";
      const excerpts = presentedTask.matches?.map(formatSearchExcerpt).join("") ?? "";

      return [
        { text: `${options.prefix ?? ""}${presentedTask.key}` },
        ...statusCells,
        columnNameCell(presentedTask.column, presentedTask.column_category),
        taskPriorityCell(presentedTask.priority, options.showsFullPriority ?? false),
        { text: `${presentedTask.title}${deadline}${claimText}${labels}${excerpts}` },
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
