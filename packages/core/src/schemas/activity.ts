import { z } from "zod";

import { standardizeProjectKey } from "../lib.js";
import { parseTaskKey } from "./task.js";

export const minimumActivityIdLength = 8;
export const activityLimitMessage = "Activity limit must be a positive safe integer";
const UUID_HEX_LENGTH = 32;

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

export const activityListSchema = z.strictObject({
  taskKey: activityTaskKeySchema.optional(),
  sessionId: z.string().min(1, "Session ID cannot be empty").optional(),
  threadId: z.string().min(1, "Thread ID cannot be empty").optional(),
  limit: z
    .number({ error: activityLimitMessage })
    .int(activityLimitMessage)
    .min(1, activityLimitMessage)
    .optional(),
});

export type ActivityListInput = z.input<typeof activityListSchema>;
