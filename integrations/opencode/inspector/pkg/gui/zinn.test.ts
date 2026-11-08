import { describe, expect, test } from "bun:test";

import { parseBoard, summarize } from "./zinn.ts";

describe("parseBoard", () => {
  test("reads the JSON after a warning line", () => {
    expect(parseBoard('warning: ignored\n[{"column":"Backlog"}]')).toEqual([{ column: "Backlog" }]);
  });

  test("throws when the output has no JSON", () => {
    expect(() => parseBoard("no tasks")).toThrow("no JSON");
  });
});

describe("summarize", () => {
  test("counts by column in the board's order", () => {
    const tasks = [{ column: "Backlog" }, { column: "Doing" }, { column: "Backlog" }];

    expect(summarize(tasks, 123)).toEqual({
      total: 3,
      columns: [
        { name: "Backlog", count: 2 },
        { name: "Doing", count: 1 },
      ],
      readAt: 123,
    });
  });

  test("counts a task with no column in the total", () => {
    expect(summarize([{ column: "" }, { column: "Done" }], 7)).toEqual({
      total: 2,
      columns: [{ name: "Done", count: 1 }],
      readAt: 7,
    });
  });
});
