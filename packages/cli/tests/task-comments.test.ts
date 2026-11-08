import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, SECTION_RULE, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task comments can be created, listed, edited, viewed, and deleted", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NOTE"], testDir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const first = await runZinn(
      ["task", "comment", "create", "NOTE-1", "--text", "First comment"],
      testDir,
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("NOTE-1#1 | First comment\n");

    const second = JSON.parse(
      (await runZinn(
        ["task", "comment", "create", "note-1", "--text", "Second comment", "--json"],
        testDir,
      )).stdout,
    );
    expect(second).toEqual({
      id: expect.any(String),
      task_id: expect.any(String),
      key: "NOTE-1#2",
      text: "Second comment",
      created_at: second.created_at,
      updated_at: second.updated_at,
    });
    expect(second.created_at).toBeNumber();
    expect(second.updated_at).toBe(second.created_at);

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 1", [
        Date.UTC(2026, 8, 24, 9, 5),
      ]);
      db.run("UPDATE comment SET created_at = ? WHERE number = 2", [
        Date.UTC(2026, 8, 25, 17, 42),
      ]);
    });

    expect(
      (await runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      })).stdout,
    ).toBe(
      "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Second comment\n",
    );

    expect(
      (await runZinn(
        ["task", "comment", "edit", second.key, "--text", "Edited second"],
        testDir,
      )).stdout,
    ).toBe("NOTE-1#2 | Edited second\n");

    const viewed = await runZinn(["task", "view", "NOTE-1"], testDir, {
      TZ: "Europe/Berlin",
    });
    expect(viewed.stdout).toContain(
      `\n\n${SECTION_RULE}\nComments:\n` +
        "NOTE-1#1 | 2026-09-24 11:05 +02:00 | First comment\n" +
        "NOTE-1#2 | 2026-09-25 19:42 +02:00 | Edited second\n",
    );

    const viewedJson = JSON.parse(
      (await runZinn(["task", "view", "NOTE-1", "--json"], testDir)).stdout,
    );
    expect(viewedJson.comments.map((entry: { key: string }) => entry.key)).toEqual([
      "NOTE-1#1",
      "NOTE-1#2",
    ]);

    const deleted = await runZinn(["task", "comment", "delete", "NOTE-1#2", "--yes"], testDir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("NOTE-1#2");

    expect(
      (await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Third comment"], testDir))
        .stdout,
    ).toBe("NOTE-1#3 | Third comment\n");

    expect(
      (await runZinn(["task", "comment", "create", "NOTE-1", "--text", "Line one\nLine two"], testDir))
        .stdout,
    ).toBe("NOTE-1#4 | Line one…\n");

    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ? WHERE number = 4", [
        Date.UTC(2026, 8, 25, 18, 7),
      ]);
    });

    const multilinePrefix = "NOTE-1#4 | 2026-09-25 20:07 +02:00 | ";
    expect(
      (await runZinn(["task", "comment", "list", "NOTE-1"], testDir, {
        TZ: "Europe/Berlin",
      })).stdout,
    ).toContain(`${multilinePrefix}Line one\n${" ".repeat(multilinePrefix.length)}Line two\n`);
  });
});

test("comment create and edit cap human echoes while reads and JSON retain the full text", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);

    const cases = [
      { text: "Short comment", preview: "Short comment" },
      { text: "x".repeat(80), preview: "x".repeat(80) },
      { text: "x".repeat(81), preview: `${"x".repeat(79)}…` },
      { text: "First line\nLater text", preview: "First line…" },
      { text: `${"x".repeat(80)}\r\nLater text`, preview: `${"x".repeat(79)}…` },
      { text: "\nLater text", preview: "…" },
    ];
    for (const { text, preview } of cases) {
      const created = await run("task", "comment", "create", "NOTE-1", "--text", text);
      expect(created.code).toBe(0);
      expect(created.stderr).toBe("");
      expect(created.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(created.stdout).toEndWith(` | ${preview}\n`);

      const key = created.stdout.split(" | ")[0]!;
      const storedText = text.replaceAll("\r\n", "\n");
      const json = await run("task", "comment", "create", "NOTE-1", "--text", text, "--json");
      expect(json.code).toBe(0);
      expect(json.stderr).toBe("");
      const jsonComment = JSON.parse(json.stdout);
      expect(jsonComment).toEqual({
        id: expect.any(String),
        task_id: expect.any(String),
        key: expect.stringMatching(/^NOTE-1#\d+$/),
        text: storedText,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      });

      const editText = `Edited ${text}`;
      const edited = await run("task", "comment", "edit", key, "--text", editText);
      expect(edited.code).toBe(0);
      expect(edited.stderr).toBe("");
      const echo = edited.stdout.slice(`${key} | `.length).trimEnd();
      expect(edited.stdout).toStartWith(`${key} | `);
      expect(echo.split("\n")).toHaveLength(1);
      expect(echo.length).toBeLessThanOrEqual(80);
      if (editText.length > 80 || editText.includes("\n")) {
        expect(echo).toEndWith("…");
      } else {
        expect(echo).toBe(editText);
      }

      const editedJson = await run("task", "comment", "edit", key, "--text", text, "--json");
      expect(editedJson.code).toBe(0);
      expect(editedJson.stderr).toBe("");
      const { changed, ...comment } = JSON.parse(editedJson.stdout);
      expect(changed).toBe(true);
      expect(comment).toEqual({
        id: expect.any(String), task_id: expect.any(String), key, text: storedText, created_at: expect.any(Number), updated_at: expect.any(Number),
      });
      const viewed = await run("task", "comment", "view", key, "--json");
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual(comment);
    }

    const fullText = "First line\n" + "Full comment text. ".repeat(20);
    const created = await run("task", "comment", "create", "NOTE-1", "--text", fullText, "--json");
    const { key } = JSON.parse(created.stdout);
    for (const args of [
      ["task", "comment", "view", key],
      ["task", "comment", "list", "NOTE-1"],
      ["task", "view", "NOTE-1"],
    ]) {
      const result = await run(...args);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(fullText.split("\n")[1]!);
    }
  });
});

test("task comment view reads only the requested current comment, including on archived tasks, without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Sibling comment")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Original text")).code).toBe(0);
    const text = "  Current first line\n\tSecond line\n" + "Full comment text. ".repeat(40) + "\n";
    const edited = await run("task", "comment", "edit", "NOTE-1#2", "--text", text, "--json");
    expect(edited.code).toBe(0);
    const { changed, ...expected } = JSON.parse(edited.stdout);
    expect(changed).toBe(true);
    const snapshot = () => withTestDb(directory, (db) => ({
      comments: db.query("SELECT * FROM comment ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));

    for (const archived of [false, true]) {
      if (archived) {
        expect((await run("task", "archive", "NOTE-1")).code).toBe(0);
      }
      const before = snapshot();
      const viewed = await run("task", "comment", "view", "note-1#2");
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      expect(viewed.stdout).toContain("NOTE-1#2");
      for (const line of text.trimEnd().split("\n")) {
        expect(viewed.stdout).toContain(line);
      }
      expect(viewed.stdout).not.toContain("Sibling comment");
      expect(viewed.stdout).not.toContain("Original text");

      const viewedJson = await run("task", "comment", "view", "note-1#2", "--json");
      expect(viewedJson.code).toBe(0);
      expect(viewedJson.stderr).toBe("");
      const data = JSON.parse(viewedJson.stdout);
      expect(data).toEqual({
        id: expected.id, task_id: expected.task_id, key: "NOTE-1#2", text, created_at: expected.created_at, updated_at: expected.updated_at,
      });
      expect(snapshot()).toEqual(before);
    }
  });
});

test("task comment view rejects malformed, missing and deleted comments with structured errors", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "NOTE")).code).toBe(0);
    expect((await run("task", "create", "NOTE", "--title", "Commented task")).code).toBe(0);
    expect((await run("task", "comment", "create", "NOTE-1", "--text", "Deleted text")).code).toBe(0);
    expect((await run("task", "comment", "delete", "NOTE-1#1", "--yes")).code).toBe(0);

    const cases = [
      { key: "NOTE-1", code: "invalid_input", details: { field: ["commentKey"] } },
      { key: "NOTE-1#1", code: "not_found", details: { entity: "comment", key: "NOTE-1#1" } },
      { key: "NOTE-1#2", code: "not_found", details: { entity: "comment", key: "NOTE-1#2" } },
      { key: "NOTE-2#1", code: "not_found", details: { entity: "task", key: "NOTE-2" } },
    ];
    for (const { key, code, details } of cases) {
      for (const json of [false, true]) {
        const flags = json ? ["--json"] : [];
        const result = await run("task", "comment", "view", key, ...flags);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toBe("");
        if (json) {
          expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code, details });
        }
      }
    }
  });
});

test("comment lists pad the key so #1 lines up with #10 and keep continuation lines under the text", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "PAD"], testDir);
    await runZinn(["task", "create", "PAD", "--title", "Many comments"], testDir);

    const createComment = (number: number) => {
      const isMultiline = number === 1 || number === 10;
      const text = isMultiline ? `Comment ${number}\nsecond line` : `Comment ${number}`;

      return runZinn(["task", "comment", "create", "PAD-1", "--text", text], testDir);
    };
    for (let number = 1; number <= 9; number += 1) {
      await createComment(number);
    }
    const tenth = await createComment(10);
    withTestDb(testDir, (db) => {
      db.run("UPDATE comment SET created_at = ?", [Date.UTC(2026, 8, 25, 18, 7)]);
    });

    // One comment on its own has nothing to line up with and prints no timestamp.
    expect(tenth.stdout).toBe("PAD-1#10 | Comment 10…\n");

    const timestamp = "2026-09-25 20:07 +02:00";
    // Later lines start under the text of the first line, after the padded key.
    const textIndent = " ".repeat(`PAD-1#10 | ${timestamp} | `.length);
    const listed = (await runZinn(["task", "comment", "list", "PAD-1"], testDir, { TZ: "Europe/Berlin" })).stdout;
    expect(listed).toBe(
      [
        `PAD-1#1  | ${timestamp} | Comment 1`,
        `${textIndent}second line`,
        `PAD-1#2  | ${timestamp} | Comment 2`,
        `PAD-1#3  | ${timestamp} | Comment 3`,
        `PAD-1#4  | ${timestamp} | Comment 4`,
        `PAD-1#5  | ${timestamp} | Comment 5`,
        `PAD-1#6  | ${timestamp} | Comment 6`,
        `PAD-1#7  | ${timestamp} | Comment 7`,
        `PAD-1#8  | ${timestamp} | Comment 8`,
        `PAD-1#9  | ${timestamp} | Comment 9`,
        `PAD-1#10 | ${timestamp} | Comment 10`,
        `${textIndent}second line`,
        "",
      ].join("\n"),
    );

    const viewed = (await runZinn(["task", "view", "PAD-1"], testDir, { TZ: "Europe/Berlin" })).stdout;
    expect(viewed).toContain(`\n\n${SECTION_RULE}\nComments:\n${listed}`);
  });
});

test("task comment commands validate their inputs without partial writes", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "NOTE"], testDir);
    await runZinn(["task", "create", "NOTE", "--title", "Commented task"], testDir);

    const cases = [
      [["task", "comment", "create", "NOTE-1"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "create", "NOTE-1", "--text", "   "], { code: "invalid_input", details: { field: ["text"] } }],
      [["task", "comment", "create", "NOTE-1", "--text", "one", "--text", "two"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "list"], { code: "invalid_input", details: { argument: "task-key" } }],
      [["task", "comment", "edit", "NOTE-1#1"], { code: "invalid_input", details: { argument: "--text" } }],
      [["task", "comment", "edit", "019dbfc3-f513-7000-8000-000000000000", "--text", "No"], { code: "invalid_input", details: { field: ["commentKey"] } }],
      [["task", "comment", "delete"], { code: "invalid_input", details: { argument: "comment-key" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn([...args, "--json"], testDir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }

    expect((await runZinn(["task", "comment", "list", "NOTE-1"], testDir)).stdout).toBe("");
  });
});
