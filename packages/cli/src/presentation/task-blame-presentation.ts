import type { PresentedTaskBlame } from "../result-schemas.js";

import { formatActor } from "./activity-presentation.js";
import { formatRelationLabel } from "./relation-presentation.js";
import { formatSection } from "./section.js";
import { formatLocalTime } from "./time.js";

type Attribution = PresentedTaskBlame["fields"]["title"]["attribution"];

export function formatTaskBlame(blame: PresentedTaskBlame) {
  const events = new Map<string, NonNullable<Attribution>>();
  function reference(attribution: Attribution) {
    if (attribution === null) {
      return "unrecorded";
    }
    events.set(attribution.id, attribution);
    return attribution.id;
  }

  function field(name: string, value: string, attribution: Attribution) {
    return `${name}: ${value} [${reference(attribution)}]`;
  }

  const { fields } = blame;
  const content = [
    `${blame.task.key} (${blame.task.id})`,
    formatSection(
      "Fields",
      [
        field("Title", fields.title.value, fields.title.attribution),
        field("Column", fields.column.value.name, fields.column.attribution),
        field("Priority", fields.priority.value ?? "none", fields.priority.attribution),
        field(
          "Due",
          fields.due_at.value === null
            ? "none"
            : formatLocalTime(fields.due_at.value, { includesSeconds: true }),
          fields.due_at.attribution,
        ),
        field(
          "Labels",
          fields.labels.value.map((label) => label.name).join(", ") || "none",
          fields.labels.attribution,
        ),
        field("Parent", fields.parent.value?.key ?? "none", fields.parent.attribution),
      ].join("\n"),
    ),
  ];

  if (blame.relations.length > 0) {
    content.push(
      formatSection(
        "Relations",
        blame.relations
          .map((entry) => field(formatRelationLabel(entry), entry.task.key, entry.attribution))
          .join("\n"),
      ),
    );
  }

  if (blame.description.length > 0) {
    content.push(
      formatSection(
        "Description",
        blame.description
          .map((line) => `${line.line} [${reference(line.attribution)}] ${line.text}`)
          .join("\n"),
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
