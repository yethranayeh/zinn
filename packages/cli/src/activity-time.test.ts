import { expect, test } from "bun:test";
import { activityTimeInputSchema } from "./activity-time";

test("time inputs preserve equivalent instants, scaled fractions and epoch milliseconds", () => {
  const base = 1_792_929_600_000;
  for (const value of ["2026-10-25T12:00:00Z", "2026-10-25T13:00:00+01:00", "2026-10-25T08:00:00-04:00", String(base)]) {
    expect(activityTimeInputSchema.parse(value)).toBe(base);
  }
  for (const [fraction, milliseconds] of [["1", 100], ["12", 120], ["123", 123], ["001", 1]] as const) {
    expect(activityTimeInputSchema.parse(`2026-10-25T12:00:00.${fraction}Z`)).toBe(base + milliseconds);
  }
  for (const value of [-8_640_000_000_000_000, -1, 0, 1, 1_700_000_000, 8_640_000_000_000_000]) {
    expect(activityTimeInputSchema.parse(String(value))).toBe(value);
  }
  expect(activityTimeInputSchema.parse("2024-02-29T00:00:00Z")).toBe(1_709_164_800_000);
  expect(activityTimeInputSchema.parse("2000-02-29T00:00:00Z")).toBe(951_782_400_000);
  expect(activityTimeInputSchema.parse("2026-10-25T02:30:00+01:00") - activityTimeInputSchema.parse("2026-10-25T02:30:00+02:00"))
    .toBe(3_600_000);
});

test("time inputs reject normalization, unsupported precision, missing offsets and numeric coercion", () => {
  for (const value of [
    "", "today", "2h", "2026-10-25", "2026-10-25T12:00:00", "2026-10-25T12:00Z",
    "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-01-00T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-32T00:00:00Z",
    "2026-10-25T24:00:00Z", "2016-12-31T23:59:60Z", "2026-10-25T12:60:00Z",
    "2026-10-25T12:00:00.1234Z", "2026-10-25T12:00:00.0000+01:00", "2026-10-25T12:00:00.Z",
    "2026-10-25T12:00:00+24:00", "2026-10-25T12:00:00+01:60", "2026-10-25T12:00:00+0100",
    "2026-10-25 12:00:00Z", "2026-10-25T12:00:00Z\n", "1\n", " 1", "1 ",
    "1.0", "1e3", "0x10", "NaN", "Infinity", "8640000000000001", "-8640000000000001",
  ]) {
    expect(activityTimeInputSchema.safeParse(value).success, value).toBe(false);
  }
});
