import { MAX_LIST_LIMIT, listLimitMessage, listLimitPattern } from "@zinn-dev/core";
import { quit } from "./lib.js";

export const listLimitDescription = `Return at most n results after all filters. Use an integer from 1 through ${MAX_LIST_LIMIT}.`;
export const listLimitOption = {
  type: "string",
  value: { kind: "positive-integer", name: "n", pattern: listLimitPattern },
  description: listLimitDescription,
} as const;

export function parseListLimit(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!new RegExp(listLimitPattern).test(value)) {
    quit(listLimitMessage, undefined, { argument: "--limit" });
  }

  return Number(value);
}
