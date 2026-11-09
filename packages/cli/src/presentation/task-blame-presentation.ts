import type { PresentedRelation, PresentedTaskBlame } from "../result-schemas.js";

import { formatActor } from "./activity-presentation.js";
import { columnNameCell } from "./column-presentation.js";
import { formatRelationList } from "./relation-presentation.js";
import { formatCell, formatCellSeparator, formatRows } from "./row-layout.js";
import { formatSection } from "./section.js";
import { formatLabelNames, taskPriorityCell } from "./task-presentation.js";
import { formatLocalTime } from "./time.js";

type Attribution = PresentedTaskBlame["fields"]["title"]["attribution"];

export function formatTaskBlame(
  blame: PresentedTaskBlame,
  options: {
    relations: Array<PresentedRelation>;
    columnCategory: string | null;
    isArchived: boolean;
    /** Short forms of activity IDs, which `activity view` accepts as well as full IDs. */
    activityIdPrefixes: Map<string, string>;
  },
) {
  const events = new Map<string, NonNullable<Attribution>>();
  function reference(attribution: Attribution) {
    if (attribution === null) {
      return "unrecorded";
    }
    events.set(attribution.id, attribution);
    return options.activityIdPrefixes.get(attribution.id) ?? attribution.id;
  }

  function field(name: string, value: string, attribution: Attribution) {
    return `${name}: ${value} [${reference(attribution)}]`;
  }

  const { fields } = blame;
  const labelNames = fields.labels.value.map((label) => label.name);
  const content = [
    `${blame.task.key} (${blame.task.id})${options.isArchived ? `${formatCellSeparator()}Archived` : ""}`,
    formatSection(
      "Fields",
      [
        field("Title", fields.title.value, fields.title.attribution),
        field(
          "Column",
          formatCell(columnNameCell(fields.column.value.name, options.columnCategory)),
          fields.column.attribution,
        ),
        field(
          "Priority",
          formatCell(taskPriorityCell(fields.priority.value, true)),
          fields.priority.attribution,
        ),
        field(
          "Due",
          fields.due_at.value === null
            ? "none"
            : formatLocalTime(fields.due_at.value, { includesSeconds: true }),
          fields.due_at.attribution,
        ),
        field(
          "Labels",
          labelNames.length === 0 ? "none" : formatLabelNames(labelNames),
          fields.labels.attribution,
        ),
        field("Parent", fields.parent.value?.key ?? "none", fields.parent.attribution),
      ].join("\n"),
    ),
  ];

  if (options.relations.length > 0) {
    const relationAttributions = new Map(
      blame.relations.map((entry) => [entry.id, entry.attribution]),
    );
    content.push(
      formatSection(
        "Relations",
        formatRelationList(options.relations, {
          trailingCell: (entry) => ({
            text: `[${reference(relationAttributions.get(entry.id) ?? null)}]`,
          }),
        }),
      ),
    );
  }

  if (blame.description.length > 0) {
    content.push(
      formatSection(
        "Description",
        formatRows(
          blame.description.map((line) => [
            { text: String(line.line) },
            { text: `[${reference(line.attribution)}]` },
            { text: line.text },
          ]),
        ),
      ),
    );
  }

  if (events.size > 0) {
    content.push(
      formatSection(
        "Attribution",
        [...events.values()]
          .map(
            (event) =>
              `${event.id}\n${formatLocalTime(event.created_at, { includesSeconds: true })}\n${formatActor(event)}`,
          )
          .join("\n\n"),
      ),
    );
  }

  return content.join("\n\n");
}
