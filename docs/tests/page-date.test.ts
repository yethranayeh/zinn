import { expect, test } from "bun:test";
import { pageDate, toIsoDate } from "../src/config/page-date";

test.each([
  ["18.10.2026", "2026-10-18"],
  ["29.02.2024", "2024-02-29"],
  ["01.01.2026", "2026-01-01"],
])("page date %s preserves authored text and supplies ISO datetime", (authored, iso) => {
  expect(pageDate.parse(authored)).toBe(authored);
  expect(toIsoDate(authored)).toBe(iso);
});

test.each([
  "29.02.2026",
  "31.04.2026",
  "00.10.2026",
  "18.13.2026",
  "2026-10-18",
  "1.1.2026",
])("page date rejects invalid or unsupported input %s", (date) => {
  expect(pageDate.safeParse(date).success).toBe(false);
});
