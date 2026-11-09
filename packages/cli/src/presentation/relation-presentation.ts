import type { TaskWithKey } from "@zinn-dev/core";
import type { PresentedRelation, PresentedRelationChange } from "../result-schemas.js";
import type { ColumnBoard } from "./column-presentation.js";
import type { RowCell } from "./row-layout.js";

import { relation } from "@zinn-dev/core";

import { columnNameCell, columnPlacement, createColumnBoard } from "./column-presentation.js";
import { formatCellSeparator, formatRows } from "./row-layout.js";

export function presentRelationChange(
  entry: ReturnType<typeof relation.create>,
  source: TaskWithKey,
  target: TaskWithKey,
): PresentedRelationChange {
  return {
    id: entry.id,
    type: entry.relation_type,
    source: source.key,
    source_task_id: source.id,
    target: target.key,
    target_task_id: target.id,
  };
}

export function presentRelations(
  taskMatch: TaskWithKey,
  board: ColumnBoard = createColumnBoard(),
): Array<PresentedRelation> {
  return relation.getAll(taskMatch.key, { include: { tasks: true } }).map((entry) => {
    const isSource = entry.source_task_id === taskMatch.id;
    const other = isSource ? entry.target : entry.source;
    if (other == null) {
      throw new Error("Connected task details were not included in the relation");
    }

    let direction: PresentedRelation["direction"] = null;
    if (entry.relation_type !== "related") {
      direction = isSource ? "outgoing" : "incoming";
    }

    const projectColumns = board(other.project_id);
    const columnMatch = projectColumns.find((boardColumn) => boardColumn.id === other.column_id)!;
    const placement = columnPlacement(projectColumns, other.column_id);

    return {
      id: entry.id,
      type: entry.relation_type,
      direction,
      task: {
        id: other.id,
        key: other.key,
        project_id: other.project_id,
        column: columnMatch.name,
        column_id: other.column_id,
        is_first: placement.is_first,
        is_last: placement.is_last,
        column_category: columnMatch.category ?? null,
        title: other.title,
        status: other.archived_at == null ? "Active" : "Archived",
      },
    };
  });
}

function formatRelationLabel(entry: Pick<PresentedRelation, "type" | "direction">) {
  const isOutgoing = entry.direction === "outgoing";

  let label = entry.type;
  switch (entry.type) {
    case "related": {
      label = "Related to";
      break;
    }
    case "dependency": {
      label = isOutgoing ? "Depends on" : "Depended on by";
      break;
    }
    case "subtask": {
      label = isOutgoing ? "Parent" : "Subtask";
      break;
    }
    case "duplicate": {
      label = isOutgoing ? "Duplicate of" : "Duplicated by";
      break;
    }
  }

  return label;
}

export function formatRelationList(
  relations: Array<PresentedRelation>,
  options: { trailingCell?: (entry: PresentedRelation) => RowCell } = {},
) {
  return formatRows(
    relations.map((entry) => {
      const label = formatRelationLabel(entry);

      const archived = entry.task.status === "Archived" ? `${formatCellSeparator()}Archived` : "";
      return [
        { text: label },
        { text: entry.task.key },
        columnNameCell(entry.task.column, entry.task.column_category),
        { text: `${entry.task.title}${archived}` },
        ...(options.trailingCell === undefined ? [] : [options.trailingCell(entry)]),
      ];
    }),
  );
}

export function formatRelationChange(
  change: Pick<PresentedRelationChange, "type" | "source" | "target">,
  options:
    | { action: "create" | "delete" }
    | { action: "replace"; replaced: Array<PresentedRelationChange> },
): string {
  if (options.action === "replace") {
    const previous = options.replaced.map((entry) =>
      formatRelationChange(entry, { action: "create" }),
    );

    return `Replace these relations:\n${previous.join("\n")}\nWith:\n${formatRelationChange(change, { action: "create" })}?`;
  }
  if (options.action === "delete") {
    return `Deleted ${change.type} relation from ${change.source} to ${change.target}`;
  }

  const label = {
    related: "related to",
    dependency: "depends on",
    duplicate: "is a duplicate of",
    subtask: "is a subtask of",
  }[change.type];

  return `${change.source} ${label} ${change.target}`;
}
