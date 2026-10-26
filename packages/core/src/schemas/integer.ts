import { z } from "zod";

export const positiveIntegerPattern = "[1-9]\\d{0,14}";
export const listLimitPattern = "^" + positiveIntegerPattern + "\\d?$";
/** Tin's approximate atomic weight */
export const MAX_LIST_LIMIT = 11_871;
export const listLimitMessage = `Limit must be an integer from 1 through ${MAX_LIST_LIMIT}`;
export const listLimitSchema = z
  .number({ error: listLimitMessage })
  .int(listLimitMessage)
  .min(1, listLimitMessage)
  .max(MAX_LIST_LIMIT, listLimitMessage);
