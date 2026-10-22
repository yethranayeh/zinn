import { expect, test } from "bun:test";
import { withEnvironment } from "../../../core/src/testing";
import { formatColumnList } from "./column-presentation";

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

test("column rows pad names inside color codes and dim separators", () => {
  withEnvironment({ FORCE_COLOR: "1", NO_COLOR: undefined }, () => {
    const separator = "\x1b[2m | \x1b[22m";
    expect(formatColumnList([
      { name: "Backlog", taskCount: 1 },
      { name: "In Progress", taskCount: 0 },
      { name: "Done", taskCount: 1 },
    ], { showsTaskCounts: true, archivedTaskCount: 1 })).toBe([
      `\x1b[90mBacklog    \x1b[39m${separator}1`,
      `In Progress${separator}0`,
      `\x1b[32mDone       \x1b[39m${separator}1`,
      `Archived   ${separator}1`,
    ].join("\n"));
    expect(formatColumnList([{ project: "MDR", name: "Backlog" }], { showsProject: true }))
      .toBe(`MDR${separator}\x1b[90mBacklog\x1b[39m`);
    expect(formatColumnList([{ project: "MDR", name: "Done" }], { showsProject: true }))
      .toBe(`MDR${separator}\x1b[32mDone\x1b[39m`);
    expect(formatColumnList([{ project: "MDR", name: "Waiting" }], { showsProject: true }))
      .toBe(`MDR${separator}Waiting`);
  });
});
