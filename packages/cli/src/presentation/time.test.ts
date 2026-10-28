import { expect, test } from "bun:test";
import { formatLocalTime } from "./time";

test("deadline precision adds seconds and nonzero milliseconds without changing default time precision", () => {
  const instant = Date.parse("2026-10-25T12:34:56.123Z");
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  const minute = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  expect(formatLocalTime(instant)).toContain(`${minute} `);
  expect(formatLocalTime(instant)).not.toContain(`${minute}:`);
  expect(formatLocalTime(instant, { includesSeconds: true })).toContain(`${minute}:56.123 `);
  expect(formatLocalTime(instant - 123, { includesSeconds: true })).toContain(`${minute}:56 `);
});
