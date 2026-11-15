import { z } from "zod";
import { quit } from "./lib.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_UNIT = { m: MS_PER_MINUTE, h: MS_PER_HOUR } as const;

export const durationPattern = "^\\d+[mh]$";

const durationInputMessage = "Use a whole number of minutes or hours, such as 30m or 2h";

export const durationInputSchema = z
  .string()
  .regex(new RegExp(durationPattern), durationInputMessage)
  .transform((value) => {
    const unit = value.at(-1) as keyof typeof MS_PER_UNIT;
    return Number(value.slice(0, -1)) * MS_PER_UNIT[unit];
  });

/** Spells milliseconds the way --lease accepts them, in whole hours when they divide evenly */
export function formatDurationInput(milliseconds: number) {
  return milliseconds % MS_PER_HOUR === 0
    ? `${milliseconds / MS_PER_HOUR}h`
    : `${milliseconds / MS_PER_MINUTE}m`;
}

/** Turns a duration such as 30m or 2h into milliseconds. Core checks the range */
export function parseDurationInput(value: string | undefined, argument: string) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = durationInputSchema.safeParse(value);
  if (!parsed.success) {
    quit(parsed.error.issues[0]!.message, undefined, { argument });
  }

  return parsed.data;
}
