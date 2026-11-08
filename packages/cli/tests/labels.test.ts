import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { runCliInTerminal } from "../testing";
import { DIM_SEPARATOR, runZinn, runZinnInTerminal, taskViewContent, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("global label workflows support repeated create/edit flags and preserve task content", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    expect((await run("project", "create", "APP")).code).toBe(0);
    for (const name of ["bug", "auth", "needs review, soon"]) {
      expect((await run("label", "create", name, "--color", "red", "--description", "Details")).code).toBe(0);
    }
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "create", "BUG")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "label", key: "BUG" } });
    expect((await run("label", "create", "invalid", "--color", "purple")).code).toBe(1);
    expect((await run("label", "list")).stdout).toContain(`${"bug".padEnd("needs review, soon".length)} | red | Details`);
    const created = await run("task", "create", "APP", "--title", "Login", "--description", "", "--label", "BUG", "--label", "AUTH");
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("APP-1 | Backlog | - | Login | auth, bug\n");
    const editedLabel = await run("label", "edit", " BUG ", "--name", " defect ", "--color", "blue", "--description", "");
    expect(editedLabel.code).toBe(0);
    expect(editedLabel.stdout).toBe("defect | blue\n");
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | Login | auth, defect\n");
    expect(JSON.parse((await run("label", "edit", "defect", "--description", "Fixed", "--json")).stdout)).toEqual({
      id: expect.any(String),
      name: "defect",
      color: "blue",
      description: "Fixed",
      changed: true,
    });
    expect((await run("task", "edit", "APP-1", "--title", "Changed", "--add-label", "NEEDS REVIEW, SOON", "--add-label", "AUTH", "--remove-label", "DEFECT")).code).toBe(0);
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe(
      "APP-1 | Backlog | - | Changed | auth, needs review, soon\n",
    );
    expect((await run("task", "edit", "APP-1", "--title", "Must not change", "--add-label", "unknown")).code).toBe(1);
    expect((await run("task", "view", "APP-1")).stdout).toContain("Changed");
    expect((await run("task", "edit", "APP-1", "--add-label", "BUG", "--remove-label", "bug")).code).toBe(1);
    expect((await run("task", "label", "add", "APP-1", "DEFECT")).stdout).toBe(
      "APP-1 | Backlog | - | Changed | auth, defect, needs review, soon\n",
    );
    expect((await run("task", "label", "remove", "APP-1", "AUTH", "dEfEcT")).stdout).toBe(
      "APP-1 | Backlog | - | Changed | needs review, soon\n",
    );
    expect((await runZinn(["label", "delete", "NEEDS REVIEW, SOON", "--yes"], dir)).code).toBe(0);
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | Changed\n");
    expect((await run("label", "list")).stdout).toContain("auth");
    for (const args of [
      ["APP", "Old positional title"],
      ["APP", "--title", "One", "--title", "Two"],
      ["APP", "--title", "One", "--description", "A", "--description", "B"],
      ["APP", "--title", "One", "--unknown", "x"],
      ["APP", "--title", "One", "--label", "missing"],
    ]) {
      expect((await run("task", "create", ...args)).code).toBe(1);
    }
    expect((await run("task", "create", "APP", "--title=--example")).stdout).toContain("APP-2");
  });
});

test.serial("label text output colors the name in a terminal and names the color when piped, while JSON keeps the color value", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);

    expect((await run("label", "create", "bug", "--color", "red", "--description", "Broken")).stdout).toBe(
      "bug | red | Broken\n",
    );
    expect((await run("label", "create", "later")).stdout).toBe("later | white\n");

    const createdInTerminal = await runZinnInTerminal(["label", "create", "chore", "--color", "gray"], dir);
    expect(createdInTerminal.code).toBe(0);
    expect(createdInTerminal.output).toBe("\x1b[90mchore\x1b[39m\n");

    const listed = (await run("label", "list")).stdout;
    expect(listed).not.toContain("\x1b[");
    for (const line of ["bug   | red   | Broken", "chore | gray", "later | white"]) {
      expect(listed).toContain(`${line}\n`);
    }
    const listedInTerminal = (await runZinnInTerminal(["label", "list"], dir)).output;
    expect(listedInTerminal).toContain(`\x1b[31mbug  \x1b[39m${DIM_SEPARATOR}Broken\n`);
    for (const colorName of ["red", "white", "gray"]) {
      expect(listedInTerminal).not.toContain(colorName);
    }

    const created = (await run("label", "create", "docs", "--color", "cyan", "--json")).stdout;
    expect(created).not.toContain("\x1b[");
    expect(JSON.parse(created)).toEqual({ id: expect.any(String), name: "docs", color: "cyan", description: null });

    const listedJson = (await run("label", "list", "--json")).stdout;
    expect(listedJson).not.toContain("\x1b[");
    expect(JSON.parse(listedJson)).toContainEqual({ id: expect.any(String), name: "bug", color: "red", description: "Broken" });
  });
});

test("label create, edit and list preview descriptions while view and JSON retain the full text", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const description = `${"x".repeat(100)}\nFull description`;
    const preview = `${"x".repeat(79)}…`;
    const created = await run("label", "create", "bug", "--description", description);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.stdout).toEndWith(` | ${preview}\n`);

    const edited = await run("label", "edit", "bug", "--description", `First line\n${description}`);
    expect(edited.code).toBe(0);
    expect(edited.stderr).toBe("");
    expect(edited.stdout).toEndWith(" | First line…\n");
    const listed = await run("label", "list");
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toEndWith(" | First line…\n");
    expect(listed.stdout).not.toContain(description);
    expect((await run("label", "view", "bug")).stdout).toContain(`First line\n${description}`);

    for (const args of [["label", "create", "docs"], ["label", "edit", "bug"]]) {
      const result = await run(...args, "--description", description, "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        id: expect.any(String),
        name: args[2], color: "white", description,
        ...(args[1] === "edit" ? { changed: true } : {}),
      });
    }

    const labels = await run("label", "list", "--json");
    expect(labels.code).toBe(0);
    expect(labels.stderr).toBe("");
    expect(JSON.parse(labels.stdout)).toEqual([
      { id: expect.any(String), name: "bug", color: "white", description },
      { id: expect.any(String), name: "docs", color: "white", description },
    ]);
    const listedLongDescriptions = await run("label", "list");
    expect(listedLongDescriptions.code).toBe(0);
    expect(listedLongDescriptions.stdout.trimEnd().split("\n")).toHaveLength(2);
    for (const line of listedLongDescriptions.stdout.trimEnd().split("\n")) {
      expect(line).toEndWith(` | ${preview}`);
    }
  });
});

test("label view preserves full descriptions and reads one case-insensitive name without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const description = "  First line\n\tSecond line\n" + "Full description. ".repeat(20) + "\n";
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("label", "create", "Needs Review", "--color", "red", "--description", description)).code).toBe(0);
    expect((await run("label", "create", "Empty")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Attached", "--label", "Needs Review")).code).toBe(0);
    const snapshot = () => withTestDb(directory, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = snapshot();
    for (const env of [{ FORCE_COLOR: "0" }, { FORCE_COLOR: "1" }]) {
      const viewed = await runZinn(["label", "view", " needs REVIEW "], directory, env);
      expect(viewed.code).toBe(0);
      expect(viewed.stderr).toBe("");
      expect(viewed.stdout).toContain("Needs Review");
      expect(viewed.stdout).toContain(description);
      expect(viewed.stdout).not.toContain("Empty");
      const viewedJson = await runZinn(["label", "view", "NEEDS review", "--json"], directory, env);
      expect(viewedJson.code).toBe(0);
      expect(viewedJson.stderr).toBe("");
      expect(JSON.parse(viewedJson.stdout)).toEqual({ id: expect.any(String), name: "Needs Review", color: "red", description });
      const empty = await runZinn(["label", "view", "empty", "--json"], directory, env);
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual({ id: expect.any(String), name: "Empty", color: "white", description: null });
      const listed = await runZinn(["label", "list"], directory, env);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("First line…");
      expect(listed.stdout).not.toContain("Second line");
    }
    expect((await run("label", "view", "Empty")).stdout).toBe("Empty | white\n");
    expect(snapshot()).toEqual(before);
  });
});

test("label view rejects invalid arguments and missing labels with structured errors", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("label", "create", "bug")).code).toBe(0);
    const cases = [
      { args: ["missing"], error: { code: "not_found", details: { entity: "label", key: "missing", source: "explicit" } } },
      { args: [" "], error: { code: "invalid_input", details: { field: ["name"] } } },
      { args: [], error: { code: "invalid_input" } },
      { args: ["bug", "extra"], error: { code: "invalid_input" } },
      { args: ["bug", "--unknown"], error: { code: "invalid_input" } },
    ];
    for (const { args, error } of cases) {
      const result = await run("label", "view", ...args, "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(error);
    }
    const missing = await run("label", "view", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("missing");
  });
});

test("label list pads names and color words so descriptions line up, with no cell for a missing description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("label", "create", "bug", "--color", "red", "--description", "Broken");
    await run("label", "create", "chore", "--color", "magenta");
    await run("label", "create", "documentation", "--color", "gray", "--description", "Docs");

    // The color word of the label without a description ends its row, and still sets the column's width.
    expect((await run("label", "list")).stdout).toBe(
      [
        "bug           | red     | Broken",
        "chore         | magenta",
        "documentation | gray    | Docs",
        "",
      ].join("\n"),
    );

    // A single label has nothing to line up with.
    expect((await run("label", "edit", "documentation", "--description", "Guides")).stdout).toBe(
      "documentation | gray | Guides\n",
    );
  });
});

test.serial("label list pads a colored name by its plain text, so color codes do not shift the descriptions", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["label", "create", "bug", "--color", "red", "--description", "Broken"], dir);
    await runZinn(["label", "create", "chore", "--color", "gray"], dir);
    await runZinn(["label", "create", "documentation", "--color", "blue", "--description", "Docs"], dir);

    // The name of a label without a description ends its row, so it is not padded.
    const expected =
      [
        `\x1b[31m${"bug".padEnd("documentation".length)}\x1b[39m${DIM_SEPARATOR}Broken`,
        "\x1b[90mchore\x1b[39m",
        `\x1b[34mdocumentation\x1b[39m${DIM_SEPARATOR}Docs`,
        "",
      ].join("\n");

    expect((await runZinnInTerminal(["label", "list"], dir)).output).toBe(expected);
    expect((await runZinn(["label", "list"], dir, { FORCE_COLOR: "1" })).stdout).toBe(expected);
  });
});

test.serial("label deletion and cancellation print the label preview on stdout with color on and off", async () => {
  for (const forceColor of ["0", "1"]) {
    await withIsolatedZinnDir(async (dir) => {
      const colorEnv = { FORCE_COLOR: forceColor };
      const created = await runZinn(
        ["label", "create", "bug", "--color", "red", "--description", "First line\nFull description"],
        dir,
        colorEnv,
      );
      expect(created.code).toBe(0);
      const row = created.stdout.trimEnd();
      expect(row).toContain("bug");
      expect(row).toContain("First line…");
      expect(row).not.toContain("Full description");
      if (forceColor === "0") {
        expect(row).toContain("red");
        expect(row).not.toContain("\x1b");
      } else {
        expect(row).toContain("\x1b[31mbug\x1b[39m");
        expect(row).not.toContain("red");
      }

      const stderrPath = join(dir, "prompt.stderr");
      const cancelled = await runCliInTerminal(["label", "delete", "bug"], {
        env: { ...TEST_ENVIRONMENT, ...colorEnv, ZINN_DIR: dir },
        cwd: dir,
        input: "n\n",
        stderrPath,
      });
      expect(cancelled.code).toBe(0);
      expect(cancelled.output).toContain(row);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("First line");
      expect((await runZinn(["label", "list"], dir, colorEnv)).stdout.trimEnd()).toBe(row);

      const deleted = await runZinn(["label", "delete", "bug", "--yes"], dir, colorEnv);
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain(row);
      expect(deleted.stderr).toBe("");
      expect((await runZinn(["label", "list", "--json"], dir)).stdout.trim()).toBe("[]");
    });
  }
});

test.serial("label deletion confirms global removal and cancellation preserves attachments and timestamps", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("project", "create", "APP");
    await run("label", "create", "bug");
    await run("label", "create", "keep");
    await run("task", "create", "APP", "--title", "First", "--label", "bug", "--label", "keep");
    await run("task", "create", "APP", "--title", "Second", "--label", "bug");
    const snapshot = () => withTestDb(dir, (db) => ({
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      attachments: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    }));
    const before = snapshot();
    const cancelled = await runCliInTerminal(["label", "delete", "bug"], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir, input: "n\n" });
    expect(cancelled.code).toBe(0);
    expect(cancelled.output).toContain("bug");
    expect(cancelled.output).toContain("[y/N]");
    expect(snapshot()).toEqual(before);
    const deleted = await runZinn(["label", "delete", "bug", "--yes"], dir);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("bug");
    expect((await run("label", "list")).stdout).toContain("keep");
    expect((await run("label", "list")).stdout).not.toContain("bug");
    expect(taskViewContent((await run("task", "view", "APP-1")).stdout)).toBe("APP-1 | Backlog | - | First | keep\n");
    expect((await run("task", "view", "APP-2")).code).toBe(0);
    const missing = await run("label", "delete", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("Are you sure");
    expect((await run("label", "delete", "--help")).stdout).toContain("Usage: zinn label delete");
  });
});

test("label edit validates changes, uniqueness, and missing labels", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    await run("label", "create", "bug");
    await run("label", "create", "auth");

    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "bug")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [] } });
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "missing", "--color", "red")).stderr)).error).toMatchObject({ code: "not_found", details: { entity: "label", key: "missing" } });
    expect((await run("label", "edit", "BUG", "--name", "Bug")).stdout).toContain("Bug");
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "bug", "--name", "AUTH")).stderr)).error).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "label", key: "AUTH" } });
    expect(errorDocumentSchema.parse(JSON.parse((await run("--json", "label", "edit", "BUG", "--name", " ")).stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["name"] } });
    expect((await run("label", "edit", "BUG", "--color", "purple")).code).toBe(1);
    expect((await run("label", "list", "--json")).stdout).toContain('"name": "Bug"');
    expect((await runZinn(["--help"], dir)).stdout).toContain("label {create|list|view|edit|delete}");
  });
});
