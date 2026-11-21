import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { parseBoard, runZinn, summarize } from "./zinn.ts";

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
    const tasks = [
      { column: "Backlog", column_category: "backlog" },
      { column: "Doing", column_category: "in_progress" },
      { column: "Backlog", column_category: "backlog" },
    ];

    expect(summarize(tasks, 123)).toEqual({
      total: 3,
      columns: [
        { name: "Backlog", count: 2, category: "backlog" },
        { name: "Doing", count: 1, category: "in_progress" },
      ],
      readAt: 123,
    });
  });

  test("counts a task with no column in the total", () => {
    expect(
      summarize(
        [
          { column: "" },
          { column: "Done", column_category: "done" },
          { column: "Done" },
        ],
        7,
      ),
    ).toEqual({
      total: 3,
      columns: [{ name: "Done", count: 2, category: "done" }],
      readAt: 7,
    });
  });
});

describe("runZinn", () => {
  test("sets the GUI client token on every call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zinn-gui-client-"));
    const script = join(directory, "zinn");
    writeFileSync(script, "#!/bin/sh\nprintf '%s' \"$ZINN_CLIENT\"\n");
    chmodSync(script, 0o755);
    const original = process.env.ZINN_CLIENT;

    try {
      process.env.ZINN_CLIENT = "rex/0.9";
      const chained = await runZinn({ file: script, prefix: [] }, [], directory);
      expect(chained).toBe(`rex/0.9 zinn-opencode:inspector-gui/${packageJson.version}`);

      delete process.env.ZINN_CLIENT;
      const own = await runZinn({ file: script, prefix: [] }, [], directory);
      expect(own).toBe(`zinn-opencode:inspector-gui/${packageJson.version}`);
    } finally {
      if (original === undefined) {
        delete process.env.ZINN_CLIENT;
      } else {
        process.env.ZINN_CLIENT = original;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
