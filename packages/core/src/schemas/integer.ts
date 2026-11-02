import { z } from "zod";

export const positiveIntegerPattern = "[1-9]\\d{0,14}";
export const listLimitPattern = "^" + positiveIntegerPattern + "\\d?$";
/** Omitting a limit returns every match, so the bound is only where numbers lose precision */
export const MAX_LIST_LIMIT = Number.MAX_SAFE_INTEGER;
export const listLimitMessage = `Limit must be an integer from 1 through ${MAX_LIST_LIMIT}`;
export const listLimitSchema = z
  .number({ error: listLimitMessage })
  .int(listLimitMessage)
  .min(1, listLimitMessage)
  .max(MAX_LIST_LIMIT, listLimitMessage);
