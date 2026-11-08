import { expect, test } from "bun:test";

import { median, nearestRankPercentile, p95 } from "./stats.ts";

test("the median of an odd count is the middle value", () => {
  expect(median([3, 1, 2])).toBe(2);
});

test("the median of an even count is the mean of the two middle values", () => {
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("p95 is the nearest rank of the sorted runs", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  expect(p95(values)).toBe(19);
  expect(p95([...values].reverse())).toBe(19);
});

test("p95 of one run is that run", () => {
  expect(p95([7])).toBe(7);
});

test("p95 of 100 runs is the 95th value", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  expect(p95(values)).toBe(95);
});

test("a percentile fraction outside (0, 1] is refused", () => {
  expect(() => nearestRankPercentile([1], 0)).toThrow();
  expect(() => nearestRankPercentile([1], 1.5)).toThrow();
});

test("empty input is refused", () => {
  expect(() => median([])).toThrow();
  expect(() => p95([])).toThrow();
});
