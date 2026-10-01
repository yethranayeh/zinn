import { z } from "zod";

import { labelNameSchema } from "./label";
import { descriptionSchema } from "./description";

export const positiveIntegerPattern = "[1-9]\\d{0,14}";

const titleMessage = "Task title cannot be blank";

export const taskTitleSchema = z
  .string({ error: titleMessage })
  .refine((value) => value.trim().length > 0, titleMessage);

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const taskCreateSchema = z.strictObject({
  project_id: z.string(),
  title: taskTitleSchema,
  description: descriptionSchema.default(null),
  priority: taskPrioritySchema.nullable().optional(),
  labelNames: z.array(labelNameSchema).optional(),
});

export const taskEditSchema = z
  .strictObject({
    taskKey: z.string(),
    title: taskTitleSchema.optional(),
    description: descriptionSchema.optional(),
    priority: taskPrioritySchema.nullable().optional(),
    addLabelNames: z.array(labelNameSchema).optional(),
    removeLabelNames: z.array(labelNameSchema).optional(),
  })
  .refine((value) => {
    const hasTitle = value.title !== undefined;
    const hasDescription = value.description !== undefined;
    const hasPriority = value.priority !== undefined;
    const hasLabelsToAdd = (value.addLabelNames?.length ?? 0) > 0;
    const hasLabelsToRemove = (value.removeLabelNames?.length ?? 0) > 0;

    return hasTitle || hasDescription || hasPriority || hasLabelsToAdd || hasLabelsToRemove;
  }, "Provide at least one field to edit: title, description, priority, or labels")
  .refine((value) => {
    const normalizedRemovedLabelNames = new Set(
      (value.removeLabelNames ?? []).map((name) => name.toLowerCase()),
    );

    const hasConflictingLabel = (value.addLabelNames ?? []).some((name) =>
      normalizedRemovedLabelNames.has(name.toLowerCase()),
    );

    return !hasConflictingLabel;
  }, "Cannot add and remove the same label");

const searchQueryMessage = "Search query cannot be blank";
export const searchLimitMessage = "Search limit must be a positive integer";

export const taskArchiveFilterSchema = z.enum(["active", "archived", "all"]);

export const taskListSchema = z.strictObject({
  projectKey: z.string().optional(),
  archive: taskArchiveFilterSchema.optional(),
  labelNames: z.array(labelNameSchema).optional(),
});

export const taskSearchSchema = z.strictObject({
  query: z
    .string({ error: searchQueryMessage })
    .refine((value) => value.trim().length > 0, searchQueryMessage),
  projectKey: z.string().optional(),
  archive: taskArchiveFilterSchema.optional(),
  labelNames: z.array(labelNameSchema).optional(),
  limit: z
    .number({ error: searchLimitMessage })
    .int(searchLimitMessage)
    .min(1, searchLimitMessage)
    .optional(),
});

export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskArchiveFilter = z.infer<typeof taskArchiveFilterSchema>;
export type TaskCreateInput = z.input<typeof taskCreateSchema>;
export type TaskEditInput = z.infer<typeof taskEditSchema>;
export type TaskListInput = z.infer<typeof taskListSchema>;
export type TaskSearchInput = z.infer<typeof taskSearchSchema>;

export function validateTaskInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("\n"));
  }

  return result.data;
}
