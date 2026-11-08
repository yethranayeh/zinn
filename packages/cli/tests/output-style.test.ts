import { expect, test } from "bun:test";

import {
  bold,
  DIM_EMPTY_PRIORITY,
  DIM_SEPARATOR,
  dim,
  GRAY_BACKLOG,
  runZinn,
  runZinnInTerminal,
  SECTION_RULE,
  taskViewContent,
  withIsolatedZinnDir,
  withTestDb,
} from "../test-helpers";

test.serial("NO_COLOR turns color off in a terminal, so text output reads as it does when piped", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "PLAIN"], dir);
    await runZinn(["task", "create", "PLAIN", "--title", "waiting"], dir);
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const noColor = { NO_COLOR: "1" };
    expect((await runZinnInTerminal(["task", "list", "PLAIN"], dir, noColor)).output).toBe(
      "PLAIN-1 | Backlog | - | waiting\n",
    );
    expect((await runZinnInTerminal(["label", "list"], dir, noColor)).output).toBe(
      "bug | red | Broken\n",
    );

    // An empty NO_COLOR counts as unset.
    expect((await runZinnInTerminal(["label", "list"], dir, { NO_COLOR: "" })).output).toBe(
      `\x1b[31mbug\x1b[39m${DIM_SEPARATOR}Broken\n`,
    );
  });
});

test.serial("FORCE_COLOR colors piped output and wins over NO_COLOR, while FORCE_COLOR=0 turns color off", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "FORCE"], dir);
    await runZinn(["task", "create", "FORCE", "--title", "waiting"], dir);
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);

    const coloredLabel = `\x1b[31mbug\x1b[39m${DIM_SEPARATOR}Broken\n`;
    expect((await runZinn(["task", "list", "FORCE"], dir, { FORCE_COLOR: "1" })).stdout).toBe(
      `FORCE-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}waiting\n`,
    );
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "1", NO_COLOR: "1" })).stdout).toBe(coloredLabel);

    // Any non-empty value other than 0 forces color; an empty FORCE_COLOR counts as unset.
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "true" })).stdout).toBe(coloredLabel);
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "" })).stdout).toBe("bug | red | Broken\n");
    expect((await runZinnInTerminal(["label", "list"], dir, { FORCE_COLOR: "0" })).output).toBe(
      "bug | red | Broken\n",
    );
  });
});

test.serial("Zinn's color policy controls rendering even when Node's environment rules differ", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    const environments = [
      { values: { FORCE_COLOR: "banana" }, pipeHasColor: true },
      { values: { FORCE_COLOR: "banana", NO_COLOR: "1" }, pipeHasColor: true },
      { values: { NODE_DISABLE_COLORS: "1" }, pipeHasColor: false },
      { values: { TERM: "dumb" }, pipeHasColor: false },
    ];

    for (const { values, pipeHasColor } of environments) {
      const env = { FORCE_COLOR: "", NO_COLOR: "", NODE_DISABLE_COLORS: "", TERM: "xterm-256color", ...values };
      const piped = await runZinn(["label", "list"], dir, env);
      expect(piped.code).toBe(0);
      expect(piped.stdout.includes("\x1b[31m")).toBe(pipeHasColor);
      expect(piped.stdout.includes("red")).toBe(!pipeHasColor);

      const terminal = await runZinnInTerminal(["label", "list"], dir, env);
      expect(terminal.code).toBe(0);
      expect(terminal.output).toContain("\x1b[31mbug\x1b[39m");
      expect(terminal.output).not.toContain("red");

      const json = await runZinn(["label", "list", "--json"], dir, env);
      expect(json.code).toBe(0);
      expect(json.stdout).not.toContain("\x1b");
      expect(JSON.parse(json.stdout)).toEqual([{ id: expect.any(String), name: "bug", color: "red", description: null }]);
    }
  });
});

test.serial("task rows color each attached label name by its label color, with dimmed separators and unchanged column widths", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "cli", "--color", "blue"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS", "--name", "Task labels"], dir);
    await runZinn(
      ["task", "create", "TAGS", "--title", "Several labels", "--priority", "urgent", "--label", "docs", "--label", "bug", "--label", "cli"],
      dir,
    );
    await runZinn(["task", "create", "TAGS", "--title", "No labels"], dir);
    await runZinn(["task", "move", "TAGS-2", "Done"], dir);

    // Labels are listed by name, and only the names are colored: the ", " joins stay plain, and the " | " before them is dimmed like the others.
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[34mcli\x1b[39m, \x1b[36mdocs\x1b[39m";
    const coloredRows = [
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}`,
      `TAGS-2${DIM_SEPARATOR}\x1b[32m${"Done".padEnd("Backlog".length)}\x1b[39m${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}No labels`,
      "",
    ].join("\n");

    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir)).output).toBe(coloredRows);
    expect((await runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toBe(coloredRows);
    expect((await runZinn(["task", "search", "Several", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect((await runZinn(["task", "list", "TAGS", "--all"], dir, { FORCE_COLOR: "1" })).stdout).toContain(
      `TAGS-1${DIM_SEPARATOR}Active${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}U${DIM_SEPARATOR}Several labels${DIM_SEPARATOR}${coloredLabels}\n`,
    );

    // A label's color applies to every task that has the label.
    await runZinn(["label", "edit", "bug", "--color", "yellow"], dir);
    expect((await runZinn(["task", "list", "TAGS"], dir, { FORCE_COLOR: "1" })).stdout).toContain(
      "\x1b[33mbug\x1b[39m, \x1b[34mcli\x1b[39m",
    );
  });
});

test.serial("label names in task write rows and in task view are colored by their label color", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS"], dir);

    const forceColor = { FORCE_COLOR: "1" };
    const coloredLabels = "\x1b[31mbug\x1b[39m, \x1b[36mdocs\x1b[39m";

    expect(
      (await runZinn(["task", "create", "TAGS", "--title", "Tagged", "--label", "docs", "--label", "bug"], dir, forceColor)).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir, forceColor)).stdout)).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(taskViewContent((await runZinnInTerminal(["task", "view", "TAGS-1"], dir)).output)).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect((await runZinn(["task", "label", "remove", "TAGS-1", "bug"], dir, forceColor)).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}\x1b[36mdocs\x1b[39m\n`,
    );
    expect((await runZinn(["task", "label", "add", "TAGS-1", "bug"], dir, forceColor)).stdout).toBe(
      `TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Tagged${DIM_SEPARATOR}${coloredLabels}\n`,
    );
    expect(
      (await runZinn(["task", "edit", "TAGS-1", "--title", "Retitled"], dir, forceColor)).stdout,
    ).toBe(`TAGS-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Retitled${DIM_SEPARATOR}${coloredLabels}\n`);
  });
});

test("task rows dim the separators and the empty priority marker, whether or not the task has a priority or labels", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["project", "create", "DIM"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Both", "--priority", "high", "--label", "bug"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Priority only", "--priority", "low"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Labels only", "--label", "bug"], dir);
    await runZinn(["task", "create", "DIM", "--title", "Neither"], dir);

    const forceColor = { FORCE_COLOR: "1" };
    const backlog = GRAY_BACKLOG;
    const red = "\x1b[31mbug\x1b[39m";
    // Priority letters stay plain; only the "-" that stands for no priority is dimmed.
    const dimmedRows = [
      `DIM-1${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}H${DIM_SEPARATOR}Both${DIM_SEPARATOR}${red}`,
      `DIM-2${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}L${DIM_SEPARATOR}Priority only`,
      `DIM-3${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Labels only${DIM_SEPARATOR}${red}`,
      `DIM-4${DIM_SEPARATOR}${backlog}${DIM_SEPARATOR}${DIM_EMPTY_PRIORITY}${DIM_SEPARATOR}Neither`,
      "",
    ].join("\n");
    const plainRows = [
      "DIM-1 | Backlog | H | Both | bug",
      "DIM-2 | Backlog | L | Priority only",
      "DIM-3 | Backlog | - | Labels only | bug",
      "DIM-4 | Backlog | - | Neither",
      "",
    ].join("\n");

    expect((await runZinn(["task", "list", "DIM"], dir, forceColor)).stdout).toBe(dimmedRows);
    expect((await runZinn(["task", "list", "DIM"], dir)).stdout).toBe(plainRows);
    expect((await runZinn(["task", "list", "DIM"], dir, { NO_COLOR: "1" })).stdout).toBe(plainRows);
    expect(taskViewContent((await runZinn(["task", "view", "DIM-3"], dir, forceColor)).stdout)).toBe(
      dimmedRows.split("\n")[2] + "\n",
    );
    expect(taskViewContent((await runZinn(["task", "view", "DIM-3"], dir)).stdout)).toBe("DIM-3 | Backlog | - | Labels only | bug\n");
  });
});

test("task view bolds its section headings and dims the separators and comment timestamps, and reads plain when piped", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) =>
      runZinn(args, dir, { TZ: "Europe/Berlin", ...env });
    await run({}, "project", "create", "MDR");
    await run({}, "label", "create", "bug", "--color", "red");
    await run({}, "label", "create", "cli", "--color", "blue");
    await run({}, "task", "create", "MDR", "--title", "Refine the numbers", "--description", "First line.\nSecond line.", "--priority", "high", "--label", "cli", "--label", "bug");
    await run({}, "task", "create", "MDR", "--title", "Check the totals");
    await run({}, "task", "relation", "create", "MDR-1", "MDR-2", "--type", "dependency");
    await run({}, "task", "comment", "create", "MDR-1", "--text", "Ready for review");
    await run({}, "task", "comment", "create", "MDR-1", "--text", "Line one\nLine two");
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 1", [Date.UTC(2026, 8, 25, 17, 42), Date.UTC(2026, 8, 25, 17, 42)]);
      db.run("UPDATE comment SET created_at = ?, updated_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 18, 7), Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // Later lines of a comment start under its text, so the indent counts the plain widths of the cells before it.
    const textIndent = " ".repeat("MDR-1#1 | 2026-09-25 19:42 +02:00 | ".length);
    const colored = await run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1");

    expect(colored.stderr).toBe("");
    expect(taskViewContent(colored.stdout)).toBe(
      [
        `MDR-1${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}High${DIM_SEPARATOR}Refine the numbers${DIM_SEPARATOR}\x1b[31mbug\x1b[39m, \x1b[34mcli\x1b[39m`,
        "",
        dim(SECTION_RULE),
        bold("Description:"),
        "First line.",
        "Second line.",
        "",
        dim(SECTION_RULE),
        bold("Relations:"),
        `Depends on${DIM_SEPARATOR}MDR-2${DIM_SEPARATOR}${GRAY_BACKLOG}${DIM_SEPARATOR}Check the totals`,
        "",
        dim(SECTION_RULE),
        bold("Comments:"),
        `MDR-1#1${DIM_SEPARATOR}${dim("2026-09-25 19:42 +02:00")}${DIM_SEPARATOR}Ready for review`,
        `MDR-1#2${DIM_SEPARATOR}${dim("2026-09-25 20:07 +02:00")}${DIM_SEPARATOR}Line one`,
        `${textIndent}Line two`,
        "",
      ].join("\n"),
    );

    const piped = [
      "MDR-1 | Backlog | High | Refine the numbers | bug, cli",
      "",
      SECTION_RULE,
      "Description:",
      "First line.",
      "Second line.",
      "",
      SECTION_RULE,
      "Relations:",
      "Depends on | MDR-2 | Backlog | Check the totals",
      "",
      SECTION_RULE,
      "Comments:",
      "MDR-1#1 | 2026-09-25 19:42 +02:00 | Ready for review",
      "MDR-1#2 | 2026-09-25 20:07 +02:00 | Line one",
      `${textIndent}Line two`,
      "",
    ].join("\n");
    expect(taskViewContent((await run({}, "task", "view", "MDR-1")).stdout)).toBe(piped);
    expect(taskViewContent((await run({ NO_COLOR: "1" }, "task", "view", "MDR-1")).stdout)).toBe(piped);
    expect((await run({ FORCE_COLOR: "1" }, "task", "view", "MDR-1", "--json")).stdout).not.toContain("\x1b");
  });
});

test("project view bolds its section headings, dims the separators and colors column names as task rows do, and project list dims the separator before a preview", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (env: Record<string, string>, ...args: Array<string>) => runZinn(args, dir, env);
    await run({}, "project", "create", "MDR", "--name", "Macrodata", "--description", "First line.\nSecond line.");
    await run({}, "task", "create", "MDR", "--title", "Waiting");
    await run({}, "task", "create", "MDR", "--title", "Finished");
    await run({}, "task", "create", "MDR", "--title", "Shelved");
    await run({}, "task", "move", "MDR-2", "Done");
    await run({}, "task", "archive", "MDR-3");

    // Column names are padded inside their color codes, to the plain width of the widest name.
    const columnWidth = "In Progress".length;
    expect((await run({ FORCE_COLOR: "1" }, "project", "view", "MDR")).stdout).toBe(
      [
        `MDR${DIM_SEPARATOR}Macrodata`,
        "",
        bold("Description:"),
        "First line.",
        "Second line.",
        "",
        bold("Columns:"),
        `\x1b[90m${"Backlog".padEnd(columnWidth)}\x1b[39m${DIM_SEPARATOR}1`,
        `${"TODO".padEnd(columnWidth)}${DIM_SEPARATOR}0`,
        `In Progress${DIM_SEPARATOR}0`,
        `${"Review".padEnd(columnWidth)}${DIM_SEPARATOR}0`,
        `\x1b[32m${"Done".padEnd(columnWidth)}\x1b[39m${DIM_SEPARATOR}1`,
        `${"Archived".padEnd(columnWidth)}${DIM_SEPARATOR}1`,
        "",
      ].join("\n"),
    );
    expect((await run({ FORCE_COLOR: "1" }, "project", "list")).stdout).toBe(
      `MDR${DIM_SEPARATOR}Macrodata${DIM_SEPARATOR}2 active${DIM_SEPARATOR}1 archived${DIM_SEPARATOR}First line. Second line.\n`,
    );

    expect((await run({}, "project", "view", "MDR")).stdout).toBe(
      [
        "MDR | Macrodata",
        "",
        "Description:",
        "First line.",
        "Second line.",
        "",
        "Columns:",
        "Backlog     | 1",
        "TODO        | 0",
        "In Progress | 0",
        "Review      | 0",
        "Done        | 1",
        "Archived    | 1",
        "",
      ].join("\n"),
    );
    expect((await run({}, "project", "list")).stdout).toBe("MDR | Macrodata | 2 active | 1 archived | First line. Second line.\n");
    expect((await run({ FORCE_COLOR: "1" }, "project", "view", "MDR", "--json")).stdout).not.toContain("\x1b");
    const columnEnvironments: Array<Record<string, string>> = [{}, { FORCE_COLOR: "1" }, { NO_COLOR: "1" }];
    for (const env of columnEnvironments) {
      const projectView = (await run(env, "project", "view", "MDR")).stdout;
      const columnList = (await run(env, "project", "column", "list", "MDR")).stdout;
      const columnsSection = projectView.split(env.FORCE_COLOR ? bold("Columns:") : "Columns:")[1]!;
      expect(columnsSection.trimStart()).toStartWith(columnList);
      expect(columnList).not.toContain("Archived");
    }
  });
});

test("comment lists dim the separators and timestamps, while a single comment has no timestamp to dim", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "NOTE"], dir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], dir);
    await runZinn(["task", "comment", "create", "NOTE-1", "--text", "First comment"], dir);
    await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Second comment"], dir);
    withTestDb(dir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [Date.UTC(2026, 8, 24, 9, 5)]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [Date.UTC(2026, 8, 25, 17, 42)]);
    });

    const env = { TZ: "Europe/Berlin" };
    const colored = await runZinn(["task", "comment", "list", "NOTE-1"], dir, { ...env, FORCE_COLOR: "1" });
    expect(colored.stdout).toBe(
      [
        `NOTE-1#1${DIM_SEPARATOR}${dim("2026-09-24 11:05 +02:00")}${DIM_SEPARATOR}First comment`,
        `NOTE-1#2${DIM_SEPARATOR}${dim("2026-09-25 19:42 +02:00")}${DIM_SEPARATOR}Second comment`,
        "",
      ].join("\n"),
    );
    expect((await runZinn(["task", "comment", "list", "NOTE-1"], dir, env)).stdout).toBe(
      [
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment",
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment",
        "",
      ].join("\n"),
    );

    expect(
      (await runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited"], dir, { FORCE_COLOR: "1" })).stdout,
    ).toBe(`NOTE-1#2${DIM_SEPARATOR}Edited\n`);
    expect((await runZinn(["task", "comment", "edit", "NOTE-1#2", "--text", "Edited again"], dir)).stdout).toBe(
      "NOTE-1#2 | Edited again\n",
    );
  });
});

test.serial("task text output names labels without color words when color is off, and JSON keeps plain label names", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red"], dir);
    await runZinn(["label", "create", "docs", "--color", "cyan"], dir);
    await runZinn(["project", "create", "TAGS"], dir);
    await runZinn(["task", "create", "TAGS", "--title", "Tagged", "--priority", "urgent", "--label", "docs", "--label", "bug"], dir);

    const plainRow = "TAGS-1 | Backlog | U | Tagged | bug, docs\n";
    const detailRow = "TAGS-1 | Backlog | Urgent | Tagged | bug, docs\n";
    const colorOff = { FORCE_COLOR: "0" };
    const noColor = { NO_COLOR: "1" };

    // Piped, with color forced off, and with NO_COLOR in a terminal all read alike, with no color words.
    expect((await runZinn(["task", "list", "TAGS"], dir)).stdout).toBe(plainRow);
    expect((await runZinn(["task", "list", "TAGS"], dir, colorOff)).stdout).toBe(plainRow);
    expect((await runZinnInTerminal(["task", "list", "TAGS"], dir, noColor)).output).toBe(plainRow);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir)).stdout)).toBe(detailRow);
    expect(taskViewContent((await runZinn(["task", "view", "TAGS-1"], dir, colorOff)).stdout)).toBe(detailRow);
    expect(taskViewContent((await runZinnInTerminal(["task", "view", "TAGS-1"], dir, noColor)).output)).toBe(detailRow);

    for (const args of [["task", "list", "TAGS", "--json"], ["task", "view", "TAGS-1", "--json"]]) {
      for (const env of [{}, { FORCE_COLOR: "1" }] as Array<Record<string, string>>) {
        const json = (await runZinn(args, dir, env)).stdout;
        expect(json).not.toContain("\x1b");
        expect([JSON.parse(json)].flat()[0].labels).toEqual(["bug", "docs"]);
      }
    }
  });
});
