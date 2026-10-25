import { z } from "zod";
import { activityTimestampSchema } from "@zinn-dev/core";

const timeInputMessage =
  "Use integer epoch milliseconds or YYYY-MM-DDTHH:mm:ss[.SSS] with Z or a numeric offset such as +01:00. Fractional seconds accept 1 to 3 digits";

const offsetTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4}/.test(value), timeInputMessage);

export const activityTimeInputSchema = z
  .string()
  .refine((value) => value.trim() === value, timeInputMessage)
  .transform((value, context) => {
    if (/^[+-]?\d+$/.test(value)) {
      return Number(value);
    }

    if (!offsetTimestampSchema.safeParse(value).success) {
      context.addIssue({ code: "custom", message: timeInputMessage });
      return z.NEVER;
    }

    return Date.parse(value);
  })
  .pipe(activityTimestampSchema);
