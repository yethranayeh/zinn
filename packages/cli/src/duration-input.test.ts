import { expect, test } from "bun:test";
import { durationInputSchema, formatDurationInput } from "./duration-input";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

test("duration inputs turn whole minutes and hours into milliseconds", () => {
  for (const [value, milliseconds] of [
    ["1m", MINUTE_MS],
    ["30m", 30 * MINUTE_MS],
    ["90m", 90 * MINUTE_MS],
    ["1h", HOUR_MS],
    ["24h", 24 * HOUR_MS],
    ["0m", 0],
    ["01h", HOUR_MS],
    ["25h", 25 * HOUR_MS],
  ] as const) {
    expect(durationInputSchema.parse(value)).toBe(milliseconds);
  }
});

test("duration inputs reject other units, fractions, signs, spaces and bare numbers", () => {
  for (const value of [
    "", "m", "h", "30", "60000", "30s", "1d", "2H", "30M", "1h30m", "1.5h", "0.5m", ".5h",
    "+30m", "-30m", "30 m", " 30m", "30m ", "30m\n", "1e3m", "0x10m", "Infinitym", "thirty m",
  ]) {
    expect(durationInputSchema.safeParse(value).success, value).toBe(false);
  }
});

test("formatted durations parse back to the same milliseconds", () => {
  for (const milliseconds of [MINUTE_MS, 30 * MINUTE_MS, 90 * MINUTE_MS, HOUR_MS, 24 * HOUR_MS]) {
    expect(durationInputSchema.parse(formatDurationInput(milliseconds))).toBe(milliseconds);
  }
});
