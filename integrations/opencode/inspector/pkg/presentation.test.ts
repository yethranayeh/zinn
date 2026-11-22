import { expect, test } from "bun:test";
import {
  CATEGORY_GLYPH,
  NAME_GLYPH,
  columnGlyph,
  isRestingColumn,
  taskPriorityCell,
  taskPriorityMeta,
} from "./presentation.ts";

test("the category decides the state glyph before the column name", () => {
  expect(columnGlyph("Shipped", "done")).toBe("●");
  expect(columnGlyph("Done", "review")).toBe("◑");
  expect(columnGlyph("Dropped", "cancelled")).toBe("✕");
  expect(columnGlyph("Done", null)).toBe("●");
  expect(columnGlyph("Shipped", null)).toBe("·");
  expect(columnGlyph("Blocked", "backlog")).toBe("○");
  expect(columnGlyph("In Progress", "in_progress")).toBe("◐");
});
test("maps every column category to its state glyph", () => {
  const expected: Record<string, string> = {
    backlog: "○",
    todo: "○",
    in_progress: "◐",
    review: "◑",
    done: "●",
    cancelled: "✕",
  };
  const categories = Object.entries(CATEGORY_GLYPH);
  expect(categories).toHaveLength(Object.keys(expected).length);
  for (const [category, glyph] of categories) {
    expect(typeof glyph).toBe("string");
    expect(columnGlyph("Any", category)).toBe(glyph!);
    expect(glyph).toBe(expected[category]);
  }
});
test("reads a null category from the column name", () => {
  for (const [column, glyph] of Object.entries(NAME_GLYPH)) {
    expect(typeof glyph).toBe("string");
    expect(columnGlyph(column, null)).toBe(glyph!);
  }
  expect(columnGlyph("Backlog", null)).toBe("○");
  expect(columnGlyph("Blocked", null)).toBe("⊘");
  expect(columnGlyph("Done", null)).toBe("●");
  expect(columnGlyph("Elsewhere", null)).toBe("·");
});
test("an archived task keeps the archived glyph", () => {
  expect(columnGlyph("Done", "done", "Archived")).toBe("▪");
  expect(columnGlyph("Blocked", null, "Archived")).toBe("▪");
});
test("treats backlog and todo columns as resting", () => {
  expect(isRestingColumn("Backlog", "backlog")).toBe(true);
  expect(isRestingColumn("TODO", "todo")).toBe(true);
  expect(isRestingColumn("Doing", "in_progress")).toBe(false);
  expect(isRestingColumn("Review", "review")).toBe(false);
  expect(isRestingColumn("Done", "done")).toBe(false);
  expect(isRestingColumn("Cancelled", "cancelled")).toBe(false);
  expect(isRestingColumn("Backlog", null)).toBe(true);
  expect(isRestingColumn("TODO", null)).toBe(true);
  expect(isRestingColumn("Doing", null)).toBe(false);
});
test("a task without a priority shows the empty cell marker", () => {
  expect(taskPriorityCell(null, { full: false })).toEqual({ text: "-", color: null, chip: false });
  expect(taskPriorityCell("", { full: true }).text).toBe("-");
});
test("a compact cell shows the CLI letter", () => {
  expect(taskPriorityCell("urgent", { full: false }).text).toBe("U");
  expect(taskPriorityCell("high", { full: false }).text).toBe("H");
  expect(taskPriorityCell("medium", { full: false }).text).toBe("M");
  expect(taskPriorityCell("low", { full: false }).text).toBe("L");
});
test("a full cell shows the word", () => {
  expect(taskPriorityCell("urgent", { full: true }).text).toBe("Urgent");
  expect(taskPriorityCell("high", { full: true }).text).toBe("High");
  expect(taskPriorityCell("medium", { full: true }).text).toBe("Medium");
  expect(taskPriorityCell("low", { full: true }).text).toBe("Low");
});
test("a priority cell carries its color and only urgent carries the chip", () => {
  for (const priority of ["urgent", "high", "medium", "low"]) {
    expect(taskPriorityCell(priority, { full: false }).color).not.toBeNull();
  }
  expect(taskPriorityCell("urgent", { full: true }).chip).toBe(true);
  expect(taskPriorityCell("high", { full: true }).chip).toBe(false);
  expect(taskPriorityCell(null, { full: false }).chip).toBe(false);
});
test("an unexpected priority takes its initial letter like the CLI", () => {
  expect(taskPriorityCell("critical", { full: false }).text).toBe("C");
  expect(taskPriorityCell("critical", { full: true }).text).toBe("Critical");
  expect(taskPriorityCell("critical", { full: true }).color).toBeNull();
});
test("the expanded meta line omits an unassigned priority", () => {
  expect(taskPriorityMeta(null)).toBeNull();
  expect(taskPriorityMeta("")).toBeNull();
  expect(taskPriorityMeta("high")?.text).toBe("High");
  expect(taskPriorityMeta("high")?.color).not.toBeNull();
});
