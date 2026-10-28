import { z } from "zod";
import { timestampSchema } from "@zinn-dev/core";

import { quit } from "./lib.js";

const timeInputMessage =
  "Use integer epoch milliseconds or YYYY-MM-DDTHH:mm:ss[.SSS] with Z or a numeric offset such as +01:00. Fractional seconds accept 1 to 3 digits";

const offsetTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4}/.test(value), timeInputMessage);

export const timestampInputSchema = z
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
  .pipe(timestampSchema);

export function parseTimestampInput(value: string | undefined, argument: string) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = timestampInputSchema.safeParse(value);
  if (!parsed.success) {
    quit(parsed.error.issues[0]!.message, undefined, { argument });
  }

  return parsed.data;
}
