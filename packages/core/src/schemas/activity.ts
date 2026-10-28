import { z } from "zod";

import { standardizeProjectKey } from "../lib.js";
import { parseTaskKey } from "./task.js";
import { projectCreateSchema } from "./project.js";
import { listLimitSchema } from "./integer.js";
import { timestampSchema } from "./timestamp.js";

export { listLimitMessage as activityLimitMessage } from "./integer.js";
export const minimumActivityIdLength = 8;
export const activityIdentitySelectors = ["projectKey", "projectId", "taskKey", "taskId"] as const;
export const activityTimestampSchema = timestampSchema;
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
const changedFieldNames = [
  "column",
  "priority",
  "labels",
  "title",
  "description",
  "due_at",
] as const;
const changedFieldMessage = `Changed field must be one of ${changedFieldNames.join(", ")}`;
export const activityChangedFieldSchema = z.enum(changedFieldNames, {
  error: changedFieldMessage,
});
export const activityChangedSchema = z.discriminatedUnion(
  "field",
  [
    z.strictObject({
      field: activityChangedFieldSchema.exclude(["priority", "title", "description", "due_at"]),
      value: z.string().min(1, "Changed value cannot be empty").optional(),
    }),
    z.strictObject({
      field: z.literal("priority"),
      value: z.string().min(1, "Changed value cannot be empty").nullable().optional(),
    }),
    z.strictObject({
      field: activityChangedFieldSchema.extract(["title", "description", "due_at"]),
      value: z
        .never({ error: "Title, description and due_at filters match any change. Omit the value" })
        .optional(),
    }),
  ],
  { error: changedFieldMessage },
);

export type ActivityAction = z.infer<typeof activityActionSchema>;
export type ActivityEntityType = z.infer<typeof activityEntityTypeSchema>;
export type ActivityChangedField = z.infer<typeof activityChangedFieldSchema>;

export const activityTaskKeySchema = z
  .string()
  .refine((value) => parseTaskKey(value) != null, "Invalid task key. Expected format PROJECT-1")
  .transform(standardizeProjectKey);

const UUID_HEX_LENGTH = 32;
const activityReferenceSchema = z.string().superRefine((value, context) => {
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
});

/** Normalizes full UUIDs and canonical left prefixes to lowercase hex. */
export const activityIdSchema = activityReferenceSchema.transform((value) =>
  value.replaceAll("-", "").toLowerCase(),
);

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
    actions: z.array(activityActionSchema).optional(),
    changed: z.array(activityChangedSchema).optional(),
    since: activityTimestampSchema.optional(),
    until: activityTimestampSchema.optional(),
    limit: listLimitSchema.optional(),
    startingAfter: activityReferenceSchema.optional(),
  })
  .superRefine((value, context) => {
    const hasReversedBounds =
      value.since !== undefined && value.until !== undefined && value.since > value.until;
    if (hasReversedBounds) {
      context.addIssue({
        code: "custom",
        path: ["until"],
        message: "Activity until must be at or after since",
      });
    }

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
