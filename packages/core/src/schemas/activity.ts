import { z } from "zod";

import { standardizeProjectKey } from "../lib.js";
import { parseTaskKey } from "./task.js";
import { projectCreateSchema } from "./project.js";

export const minimumActivityIdLength = 8;
export const activityLimitMessage = "Activity limit must be a positive safe integer";
const UUID_HEX_LENGTH = 32;
export const activityIdentitySelectors = ["projectKey", "projectId", "taskKey", "taskId"] as const;

export const activityProjectKeySchema =
  projectCreateSchema.shape.key.transform(standardizeProjectKey);

export const activityActionSchema = z.enum([
  "create",
  "edit",
  "move",
  "order",
  "archive",
  "unarchive",
  "delete",
  "relation_create",
  "relation_delete",
  "comment_create",
  "comment_edit",
  "comment_delete",
]);
export const activityEntityTypeSchema = z.enum(["task", "project", "column", "label"]);

export type ActivityAction = z.infer<typeof activityActionSchema>;
export type ActivityEntityType = z.infer<typeof activityEntityTypeSchema>;

export const activityTaskKeySchema = z
  .string()
  .refine((value) => parseTaskKey(value) != null, "Invalid task key. Expected format PROJECT-1")
  .transform(standardizeProjectKey);

/** Normalizes full UUIDs and canonical left prefixes to lowercase hex. */
export const activityIdSchema = z
  .string()
  .superRefine((value, context) => {
    const hex = value.replaceAll("-", "").toLowerCase();
    const canonical = hex
      .padEnd(UUID_HEX_LENGTH, "0")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const isHex = /^[\da-f]+$/.test(hex) && hex.length <= UUID_HEX_LENGTH;
    const hasCanonicalHyphens = !value.includes("-") || canonical.startsWith(value.toLowerCase());

    if (!isHex || !hasCanonicalHyphens) {
      context.addIssue({
        code: "custom",
        message:
          "Invalid activity ID. Use a UUID or its left prefix, with canonical hyphens or hexadecimal digits",
      });
    } else if (hex.length < minimumActivityIdLength) {
      context.addIssue({
        code: "custom",
        message: `Activity ID prefixes need at least ${minimumActivityIdLength} hexadecimal digits`,
      });
    }
  })
  .transform((value) => value.replaceAll("-", "").toLowerCase());

/** Accepts the full UUID spellings used by activity lookup, without any prefixes */
function fullActivityEntityIdSchema(entity: string) {
  return z.string({ error: `${entity} ID must be a string` }).transform((value, context) => {
    const parsed = activityIdSchema.safeParse(value);
    if (!parsed.success || parsed.data.length !== UUID_HEX_LENGTH) {
      context.addIssue({
        code: "custom",
        message: `Invalid ${entity.toLowerCase()} ID. Use a full UUID with canonical hyphens or 32 hexadecimal digits`,
      });
      return z.NEVER;
    }

    return parsed.data.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  });
}

export const activityTaskIdSchema = fullActivityEntityIdSchema("Task");
export const activityProjectIdSchema = fullActivityEntityIdSchema("Project");

export const activityListSchema = z
  .strictObject({
    projectKey: activityProjectKeySchema.optional(),
    projectId: activityProjectIdSchema.optional(),
    taskKey: activityTaskKeySchema.optional(),
    taskId: activityTaskIdSchema.optional(),
    showDeleted: z.boolean().optional(),
    sessionId: z.string().min(1, "Session ID cannot be empty").optional(),
    threadId: z.string().min(1, "Thread ID cannot be empty").optional(),
    limit: z
      .number({ error: activityLimitMessage })
      .int(activityLimitMessage)
      .min(1, activityLimitMessage)
      .optional(),
  })
  .superRefine((value, context) => {
    const suppliedSelectors = activityIdentitySelectors.filter(
      (selector) => value[selector] !== undefined,
    );

    if (suppliedSelectors.length > 1) {
      context.addIssue({
        code: "custom",
        path: [suppliedSelectors[1]!],
        message: "Use one of projectKey, projectId, taskKey or taskId",
      });
    }

    const hasUnscopedDeletedSelection =
      value.showDeleted !== undefined &&
      value.taskKey === undefined &&
      value.projectKey === undefined;

    if (hasUnscopedDeletedSelection) {
      context.addIssue({
        code: "custom",
        path: ["showDeleted"],
        message: "showDeleted requires projectKey or taskKey",
      });
    }
  });

export type ActivityListInput = z.input<typeof activityListSchema>;
