import { z } from "zod";

import { InputValidationError } from "../errors.js";
import { standardizeName, standardizeProjectKey } from "../lib.js";
import { titleTextSchema } from "./title-text.js";
import { columnNameSchema } from "./column.js";
import { labelNameSchema } from "./label.js";
import { descriptionSchema, descriptionEditSchema } from "./description.js";
import { relationTypeSchema } from "./relation.js";
import { projectKeyPattern } from "./project.js";
import { positiveIntegerPattern, listLimitSchema } from "./integer.js";
import { timestampSchema } from "./timestamp.js";

export { positiveIntegerPattern } from "./integer.js";
export { listLimitMessage as searchLimitMessage } from "./integer.js";

const taskKeyRegex = new RegExp(`^(${projectKeyPattern})-(${positiveIntegerPattern})$`);

export function parseTaskKey(taskKey: string) {
  const taskKeyMatch = taskKeyRegex.exec(taskKey);
  if (taskKeyMatch == null) {
    return null;
  }

  return { projectKey: taskKeyMatch[1]!, taskNumber: Number(taskKeyMatch[2]) };
}

export const taskTitleSchema = titleTextSchema(
  "Task title cannot be blank",
  "Task title cannot contain line breaks or control characters",
);

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const taskDeleteManySchema = z
  .array(z.string())
  .min(1, "At least one task key is required")
  .superRefine((taskKeys, context) => {
    const seen = new Set<string>();

    for (const [index, taskKey] of taskKeys.entries()) {
      const normalizedKey = standardizeProjectKey(taskKey);
      if (seen.has(normalizedKey)) {
        context.addIssue({
          code: "custom",
          message: `Task "${normalizedKey}" is listed more than once`,
          path: [index],
        });
      }
      seen.add(normalizedKey);
    }
  });

export const taskOrderManySchema = z.discriminatedUnion("direction", [
  z.strictObject({
    taskKeys: z.array(z.string()).min(1, "At least one task key is required"),
    direction: z.enum(["top", "up", "down", "bottom"]),
  }),
  z.strictObject({
    taskKeys: z.array(z.string()).min(1, "At least one task key is required"),
    direction: z.enum(["before", "after"]),
    targetTaskKey: z.string(),
  }),
]);

export const taskCreateSchema = z.strictObject({
  project_id: z.string(),
  title: taskTitleSchema,
  description: descriptionSchema.default(null),
  priority: taskPrioritySchema.nullable().optional(),
  due_at: timestampSchema.nullable().optional(),
  labelNames: z.array(labelNameSchema).optional(),
  columnName: columnNameSchema.optional(),
  // The new task is the source and targetTaskKey the target, as in relation create.
  relations: z
    .array(z.strictObject({ relation_type: relationTypeSchema, targetTaskKey: z.string() }))
    .optional(),
});

export const taskEditSchema = z
  .strictObject({
    taskKey: z.string(),
    title: taskTitleSchema.optional(),
    description: descriptionEditSchema.optional(),
    priority: taskPrioritySchema.nullable().optional(),
    due_at: timestampSchema.nullable().optional(),
    addLabelNames: z.array(labelNameSchema).optional(),
    removeLabelNames: z.array(labelNameSchema).optional(),
  })
  .refine((value) => {
    const hasTitle = value.title !== undefined;
    const hasDescription = value.description !== undefined;
    const hasPriority = value.priority !== undefined;
    const hasDeadline = value.due_at !== undefined;
    const hasLabelsToAdd = (value.addLabelNames?.length ?? 0) > 0;
    const hasLabelsToRemove = (value.removeLabelNames?.length ?? 0) > 0;

    return (
      hasTitle ||
      hasDescription ||
      hasPriority ||
      hasDeadline ||
      hasLabelsToAdd ||
      hasLabelsToRemove
    );
  }, "Provide at least one field to edit: title, description, priority, due_at, or labels")
  .refine((value) => {
    const normalizedRemovedLabelNames = new Set(
      (value.removeLabelNames ?? []).map(standardizeName),
    );

    const hasConflictingLabel = (value.addLabelNames ?? []).some((name) =>
      normalizedRemovedLabelNames.has(standardizeName(name)),
    );

    return !hasConflictingLabel;
  }, "Cannot add and remove the same label");

const searchQueryMessage = "Search query cannot be blank";

export const taskArchiveFilterSchema = z.enum(["active", "archived", "all"]);
export const taskSortSchema = z.enum(["activity", "due"]);

const deadlineFilters = {
  dueSince: timestampSchema.optional(),
  dueUntil: timestampSchema.optional(),
};

function validateDeadlineBounds(
  value: { dueSince?: number; dueUntil?: number },
  context: z.RefinementCtx,
) {
  const hasReversedBounds =
    value.dueSince !== undefined && value.dueUntil !== undefined && value.dueSince > value.dueUntil;
  if (hasReversedBounds) {
    context.addIssue({
      code: "custom",
      path: ["dueUntil"],
      message: "dueUntil must be at or after dueSince",
    });
  }
}

export const taskListSchema = z
  .strictObject({
    ...deadlineFilters,
    limit: listLimitSchema.optional(),
    sort: taskSortSchema.optional(),
    projectKey: z.string().optional(),
    columnName: columnNameSchema.optional(),
    archive: taskArchiveFilterSchema.optional(),
    labelNames: z.array(labelNameSchema).optional(),
  })
  .superRefine(validateDeadlineBounds);

export const taskSearchSchema = z
  .strictObject({
    ...deadlineFilters,
    query: z
      .string({ error: searchQueryMessage })
      .refine((value) => value.trim().length > 0, searchQueryMessage),
    projectKey: z.string().optional(),
    archive: taskArchiveFilterSchema.optional(),
    labelNames: z.array(labelNameSchema).optional(),
    limit: listLimitSchema.optional(),
  })
  .superRefine(validateDeadlineBounds);

export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskOrderManyInput = z.input<typeof taskOrderManySchema>;
export type TaskArchiveFilter = z.infer<typeof taskArchiveFilterSchema>;
export type TaskCreateInput = z.input<typeof taskCreateSchema>;
export type TaskEditInput = z.infer<typeof taskEditSchema>;
export type TaskListInput = z.infer<typeof taskListSchema>;
export type TaskSearchInput = z.infer<typeof taskSearchSchema>;

export function validateTaskInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InputValidationError(result.error.issues);
  }

  return result.data;
}
