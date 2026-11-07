import { expect, test } from "bun:test";
import { figuresAt, positionOf, tasksAt } from "../src/components/pricing/calculator-scale";
import { calculatorStops } from "../src/components/pricing/figures";

test("every measured stop round-trips through its position", () => {
  for (const stop of calculatorStops) {
    expect(tasksAt(positionOf(stop.tasks))).toBe(stop.tasks);
  }
});

test("a measured stop returns its own figures", () => {
  for (const stop of calculatorStops) {
    expect(figuresAt(calculatorStops, stop.tasks)).toEqual({ ...stop, exact: true });
  }
});

test("between the last two stops, each figure is the linear midpoint", () => {
  const low = calculatorStops[calculatorStops.length - 2];
  const high = calculatorStops[calculatorStops.length - 1];
  const figures = figuresAt(calculatorStops, (low.tasks + high.tasks) / 2);
  const byteFields = ["databaseBytes", "memoryBytes", "outputBytes", "jsonOutputBytes"] as const;
  for (const field of byteFields) {
    expect(figures[field]).toBe(Math.round((low[field] + high[field]) / 2));
  }
  expect(figures.seconds).toBe((low.seconds + high.seconds) / 2);
  expect(figures.exact).toBe(false);
});

test("every byte figure is a whole number between the measured stops", () => {
  const byteFields = ["databaseBytes", "memoryBytes", "outputBytes", "jsonOutputBytes"] as const;
  for (let tasks = 1; tasks <= 1_000; tasks += 1) {
    const figures = figuresAt(calculatorStops, tasks);
    for (const field of byteFields) {
      expect(Number.isInteger(figures[field])).toBe(true);
    }
  }
});
