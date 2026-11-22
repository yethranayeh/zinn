import { expect, test } from "bun:test";
import { pickerOptions } from "./picker.ts";
import type { TaskSummary } from "./types.ts";

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  key: "ZTP-1",
  title: "Fix the calibration",
  status: "Active",
  column: "Doing",
  columnCategory: "in_progress",
  priority: "high",
  labels: [],
  claim: null,
  ...over,
});
test("shows a known task as key, glyph, priority and title", () => {
  const options = pickerOptions(["ZTP-1"], new Map([["ZTP-1", summary()]]), false);
  expect(options).toEqual([
    { title: "ZTP-1 | ◐ H | Fix the calibration", value: "ZTP-1" },
  ]);

  const title = options[0]?.title ?? "";
  const glyphAt = title.indexOf("◐");
  const priorityAt = title.indexOf("H");
  const titleAt = title.indexOf("Fix the calibration");
  expect(glyphAt).toBeGreaterThan(-1);
  expect(priorityAt).toBeGreaterThan(glyphAt);
  expect(titleAt).toBeGreaterThan(priorityAt);
});
test("pads every key to the longest key in the list", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ key: "ZTP-1" })],
    ["ZTP-100", summary({ key: "ZTP-100", title: "Ship the release" })],
  ]);
  const options = pickerOptions(["ZTP-1", "ZTP-100"], tasks, false);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1   | ◐ H | Fix the calibration",
    "ZTP-100 | ◐ H | Ship the release",
  ]);
});
test("a filtered-out key does not widen the key column", () => {
  const tasks = new Map([["ZTP-1", summary()]]);
  const options = pickerOptions(["ZTP-1", "ZTP-999"], tasks, false);
  expect(options.map((option) => option.title)).toEqual(["ZTP-1 | ◐ H | Fix the calibration"]);
});
test("uses the column name when the category is missing", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ column: "Done", columnCategory: null })],
    ["ZTP-2", summary({ key: "ZTP-2", column: "Backlog", columnCategory: null })],
  ]);
  const options = pickerOptions(["ZTP-1", "ZTP-2"], tasks, false);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1 | ● H | Fix the calibration",
    "ZTP-2 | ○ H | Fix the calibration",
  ]);
});
test("the column category decides the glyph before the name", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ key: "ZTP-1", column: "Doing", columnCategory: "in_progress" })],
    [
      "ZTP-2",
      summary({ key: "ZTP-2", column: "Shipped", columnCategory: "done", title: "Ship the release" }),
    ],
  ]);
  const options = pickerOptions(["ZTP-1", "ZTP-2"], tasks, false);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1 | ◐ H | Fix the calibration",
    "ZTP-2 | ● H | Ship the release",
  ]);
});
test("shows the priority letter next to the state glyph", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ priority: "urgent" })],
    ["ZTP-2", summary({ key: "ZTP-2", priority: "low" })],
  ]);
  const options = pickerOptions(["ZTP-1", "ZTP-2"], tasks, false);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1 | ◐ U | Fix the calibration",
    "ZTP-2 | ◐ L | Fix the calibration",
  ]);
});
test("shows the empty marker without a priority", () => {
  for (const priority of [null, "", "none"]) {
    const tasks = new Map([["ZTP-1", summary({ priority })]]);
    const options = pickerOptions(["ZTP-1"], tasks, false);
    expect(options[0]?.title).toBe("ZTP-1 | ◐ - | Fix the calibration");
    expect(options[0]).not.toHaveProperty("description");
  }
});
test("shows an archived task with the archived glyph", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ status: "Archived", column: "Done", columnCategory: "done" })],
  ]);
  const options = pickerOptions(["ZTP-1"], tasks, false);
  expect(options[0]?.title).toBe("ZTP-1 | ▪ H | Fix the calibration");
});
test("shows an unknown key as not in store", () => {
  const tasks = new Map([["ZTP-1", summary()]]);
  const options = pickerOptions(["ZTP-1", "ZTP-999"], tasks, true);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1   | ◐ H | Fix the calibration",
    "ZTP-999 | ✗ not in store",
  ]);
  expect(options[1]).not.toHaveProperty("description");
  expect(options[1]?.value).toBe("ZTP-999");
  expect(pickerOptions(["ZTP-9"], undefined, false)).toHaveLength(0);
});
