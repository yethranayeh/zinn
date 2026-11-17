import type { PresentedTaskDetail } from "../../../../packages/cli/src/result-schemas.js";
import type { TaskEdits } from "./task-actions";

export const EDIT_FIELDS = ["title", "description", "priority"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export type EditValues = Required<TaskEdits>;
export type ConflictChoices = Partial<Record<EditField, "draft" | "saved">>;

export function editValues(task: Pick<PresentedTaskDetail, EditField>): EditValues {
  return { title: task.title, description: task.description ?? "", priority: task.priority };
}

export function changedEdits(base: EditValues, values: EditValues): TaskEdits {
  const edits: TaskEdits = {};
  if (values.title !== base.title) {
    edits.title = values.title;
  }

  if (values.description !== base.description) {
    edits.description = values.description;
  }

  if (values.priority !== base.priority) {
    edits.priority = values.priority;
  }

  return edits;
}

export function applyConflictChoices(
  base: EditValues,
  values: EditValues,
  saved: EditValues,
  choices: ConflictChoices,
) {
  const nextBase = { ...base };
  const nextValues = { ...values };
  function apply<Field extends EditField>(field: Field) {
    const choice = choices[field];
    if (choice === undefined) {
      return;
    }
    // Only explicitly reviewed fields acquire a new expected value.
    nextBase[field] = saved[field];
    if (choice === "saved") {
      nextValues[field] = saved[field];
    }
  }
  EDIT_FIELDS.forEach(apply);
  return { base: nextBase, values: nextValues };
}
