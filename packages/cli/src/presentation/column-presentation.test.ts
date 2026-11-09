import { expect, test } from "bun:test";
import { withEnvironment } from "../../../core/src/testing";
import type { ColumnCategory } from "@zinn-dev/core";

import { columnCategorySchema } from "@zinn-dev/core";
import { columnNameCell, formatColumnList } from "./column-presentation";

test("column rows align names and task counts without an archived total by default", () => {
  withEnvironment({ FORCE_COLOR: "0" }, () => {
    const columns = [
      { name: "Backlog", taskCount: 0 },
      { name: "Next up", taskCount: 1 },
      { name: "In Progress", taskCount: 0 },
      { name: "Review", taskCount: 0 },
      { name: "Done", taskCount: 0 },
    ];
    expect(formatColumnList(columns, { showsTaskCounts: true })).toBe(
      "Backlog     | 0\nNext up     | 1\nIn Progress | 0\nReview      | 0\nDone        | 0",
    );
    expect(formatColumnList(columns)).toBe("Backlog\nNext up\nIn Progress\nReview\nDone");
    expect(formatColumnList([])).toBe("");
  });
});

test("column mutation rows include the project only when requested", () => {
  withEnvironment({ FORCE_COLOR: "0" }, () => {
    const columns = [{ project: "COL", name: "Next up" }];
    expect(formatColumnList(columns, { showsProject: true })).toBe("COL | Next up");
    expect(formatColumnList(columns)).toBe("Next up");
  });
});

test("column rows append a positive archived total and omit a zero total", () => {
  withEnvironment({ FORCE_COLOR: "0" }, () => {
    const columns = [{ name: "Done", taskCount: 2 }];
    expect(formatColumnList(columns, { showsTaskCounts: true, archivedTaskCount: 1 }))
      .toBe("Done     | 2\nArchived | 1");
    expect(formatColumnList(columns, { showsTaskCounts: true, archivedTaskCount: 0 }))
      .toBe("Done | 2");
  });
});

test("column names are colored by their category, whatever their names or positions", () => {
  withEnvironment({ FORCE_COLOR: "1", NO_COLOR: undefined }, () => {
    const gray = "90";
    const blue = "34";
    const yellow = "33";
    const green = "32";
    const expectedColors: Array<[ColumnCategory, string | undefined]> = [
      ["backlog", gray],
      ["todo", undefined],
      ["in_progress", blue],
      ["review", yellow],
      ["done", green],
      ["cancelled", gray],
    ];
    // Every category is covered, so a new one needs a decided color here.
    expect(expectedColors.map(([category]) => category)).toEqual(columnCategorySchema.options);

    for (const [category, color] of expectedColors) {
      const name = `Shelf ${category}`;
      const coloredName = color === undefined ? name : `\x1b[${color}m${name}\x1b[39m`;
      expect(formatColumnList([{ name, category }]).startsWith(coloredName)).toBe(true);
    }

    // Older databases have no categories, and a category from a newer Zinn has no color here.
    expect(columnNameCell("Done", null)).toEqual({ text: "Done" });
    expect(columnNameCell("Done")).toEqual({ text: "Done" });
    expect(columnNameCell("Done", "blocked")).toEqual({ text: "Done" });
  });
});

test("column rows show the category after the name, empty when an older database has none", () => {
  withEnvironment({ FORCE_COLOR: "0" }, () => {
    const columns = [
      { name: "Backlog", category: "backlog", taskCount: 2 },
      { name: "Shipped", category: "done", taskCount: 0 },
      { name: "Legacy", category: null, taskCount: 1 },
    ];
    expect(formatColumnList(columns, { showsTaskCounts: true, archivedTaskCount: 3 })).toBe(
      "Backlog  | backlog | 2\nShipped  | done    | 0\nLegacy   |         | 1\nArchived |         | 3",
    );
  });
});
