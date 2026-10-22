import type { TaskWithKey } from "@zinn-dev/core";
import type { PresentedRelation, PresentedRelationChange } from "../result-schemas.js";

import { column, relation } from "@zinn-dev/core";

import { columnNameCell } from "./column-presentation.js";
import { formatCellSeparator, formatRows } from "./row-layout.js";

export function presentRelations(taskMatch: TaskWithKey): Array<PresentedRelation> {
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

    return {
      type: entry.relation_type,
      direction,
      task: {
        key: other.key,
        column: column.getById(other.column_id)!.name,
        title: other.title,
        status: other.archived_at == null ? "Active" : "Archived",
      },
    };
  });
}

export function formatRelationList(relations: Array<PresentedRelation>) {
  return formatRows(
    relations.map((entry) => {
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

      const archived = entry.task.status === "Archived" ? `${formatCellSeparator()}Archived` : "";
      return [
        { text: label },
        { text: entry.task.key },
        columnNameCell(entry.task.column),
        { text: `${entry.task.title}${archived}` },
      ];
    }),
  );
}

export function formatRelationChange(
  change: PresentedRelationChange,
  options: { action: "create" | "delete" },
) {
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
