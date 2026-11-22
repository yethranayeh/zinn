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
test("shows a known task as key, glyph, title", () => {
  const options = pickerOptions(["ZTP-1"], new Map([["ZTP-1", summary()]]), false);
  expect(options).toHaveLength(1);
  expect(options[0]?.title).toBe("ZTP-1 ◐ Fix the calibration");
  expect(options[0]?.description).toBe("high");
  expect(options[0]?.value).toBe("ZTP-1");
  const titleAt = options[0]?.title.indexOf("Fix the calibration") ?? -1;
  const glyphAt = options[0]?.title.indexOf("◐") ?? -1;
  expect(glyphAt).toBeGreaterThan(-1);
  expect(glyphAt).toBeLessThan(titleAt);
});
test("uses the column name when the category is missing", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ column: "Done", columnCategory: null })],
    ["ZTP-2", summary({ key: "ZTP-2", column: "Backlog", columnCategory: null })],
  ]);
  const options = pickerOptions(["ZTP-1", "ZTP-2"], tasks, false);
  expect(options.map((option) => option.title)).toEqual([
    "ZTP-1 ● Fix the calibration",
    "ZTP-2 ○ Fix the calibration",
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
    "ZTP-1 ◐ Fix the calibration",
    "ZTP-2 ● Ship the release",
  ]);
});
test("keeps only the priority as the description", () => {
  const tasks = new Map([["ZTP-1", summary({ priority: "urgent" })]]);
  const options = pickerOptions(["ZTP-1"], tasks, false);
  expect(options[0]?.description).toBe("urgent");
});
test("omits the description without a priority", () => {
  for (const priority of [null, "", "none"]) {
    const tasks = new Map([["ZTP-1", summary({ priority })]]);
    const options = pickerOptions(["ZTP-1"], tasks, false);
    expect(options[0]?.description).toBeUndefined();
    expect(options[0]).not.toHaveProperty("description");
  }
});
test("shows an archived task with the archived glyph", () => {
  const tasks = new Map([
    ["ZTP-1", summary({ status: "Archived", column: "Done", columnCategory: "done" })],
  ]);
  const options = pickerOptions(["ZTP-1"], tasks, false);
  expect(options[0]?.title).toBe("ZTP-1 ▪ Fix the calibration");
});
test("shows an unknown key as not in store", () => {
  const options = pickerOptions(["ZTP-9"], undefined, true);
  expect(options).toHaveLength(1);
  expect(options[0]?.title).toBe("ZTP-9 ✗ not in store");
  expect(options[0]).not.toHaveProperty("description");
  expect(options[0]?.value).toBe("ZTP-9");
  expect(pickerOptions(["ZTP-9"], undefined, false)).toHaveLength(0);
});
