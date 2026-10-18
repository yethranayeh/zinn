import { z } from "astro/zod";

export function toIsoDate(date: string): string {
  return date.split(".").reverse().join("-");
}

export const pageDate = z
  .string()
  .regex(/^\d{2}\.\d{2}\.\d{4}$/)
  .refine((date) => z.iso.date().safeParse(toIsoDate(date)).success, {
    message: "Use a valid calendar date in DD.MM.YYYY format.",
  });
