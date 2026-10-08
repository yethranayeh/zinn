import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commentEditSchema } from "./schemas/comment";
import { labelEditSchema } from "./schemas/label";
import { projectEditSchema } from "./schemas/project";
import { taskEditSchema } from "./schemas/task";
import { textEditSchema } from "./schemas/text-edit";

// ZINN-177: partial edits of descriptions and comment text.

function runTextEditCheck(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-text-edit-"));
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
          import { strict as assert } from "node:assert";
          import { project, task, label, comment, TextEditMatchError } from ${JSON.stringify(new URL("../index.ts", import.meta.url).pathname)};
          import * as dbActivity from ${JSON.stringify(new URL("./db/activity.ts", import.meta.url).pathname)};
          import { getDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).pathname)};
          const human = { name: "Test Human", email: "human@example.com", kind: "human" };
          const app = project.create({ key: "APP" }, human);
          const matchError = (count, target) => (error) =>
            error instanceof TextEditMatchError && error.matchCount === count && error.target === target;
          // Each description field, as one editable record with read, edit and history access.
          const fields = [
            {
              target: "APP-1's description",
              make: (description) => {
                task.create({ project_id: app.id, title: "Task", description }, human);
                return {
                  edit: (description) => task.edit({ taskKey: "APP-1", description }, human),
                  read: () => getDb().query("SELECT description AS text, updated_at FROM task WHERE title = 'Task'").get(),
                  history: () => task.activity("APP-1"),
                };
              },
            },
            {
              target: "project PRJ's description",
              make: (description) => {
                project.create({ key: "PRJ", description }, human);
                return {
                  edit: (description) => project.edit({ projectKey: "PRJ", description }, human),
                  read: () => getDb().query("SELECT description AS text, updated_at FROM project WHERE key = 'PRJ'").get(),
                  history: () => dbActivity.getAllByEntity("project", project.getByKey("PRJ").id),
                };
              },
            },
            {
              target: "label bug's description",
              make: (description) => {
                const created = label.create({ name: "bug", description }, human);
                return {
                  edit: (description) => label.edit({ labelName: "bug", description }, human),
                  read: () => getDb().query("SELECT description AS text, 0 AS updated_at FROM label WHERE name = 'bug'").get(),
                  history: () => dbActivity.getAllByEntity("label", created.id),
                };
              },
            },
          ];
          ${script}
        `,
      ],
      { env: { ...process.env, ZINN_DIR: directory } },
    );

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Runs `body` once per description field, each with a fresh record made from `initial`. */
function forEachDescriptionField(initial: string | null, body: string) {
  runTextEditCheck(`
    for (const field of fields) {
      const record = field.make(${JSON.stringify(initial)});
      const target = field.target;
      ${body}
      // The next field reuses the same task, project and label names.
      getDb().exec("DELETE FROM task; DELETE FROM label; DELETE FROM project WHERE key != 'APP'");
    }
  `);
}

test("text edit schema accepts one append or one find/replace and nothing else", () => {
  expect(textEditSchema.parse({ append: "More" })).toEqual({ append: "More" });
  expect(textEditSchema.parse({ find: "a", replace: "" })).toEqual({ find: "a", replace: "" });
  expect(textEditSchema.parse({ find: "a", replace: "b", all: true })).toEqual({
    find: "a",
    replace: "b",
    all: true,
  });

  expect(() => textEditSchema.parse({ append: "  \n" })).toThrow("Text to append cannot be blank");
  expect(() => textEditSchema.parse({ find: "", replace: "b" })).toThrow(
    "Text to find cannot be empty",
  );
  expect(() => textEditSchema.parse({ find: "a" })).toThrow();
  expect(() => textEditSchema.parse({ append: "x", find: "a", replace: "b" })).toThrow();
  expect(() => textEditSchema.parse({ append: "x", all: true })).toThrow();
  expect(() => textEditSchema.parse({ find: "a", replace: "b", extra: 1 })).toThrow();
});

test("edit schemas take full text or an edit object in each text field", () => {
  const edit = { find: "a", replace: "b" };

  expect(taskEditSchema.parse({ taskKey: "APP-1", description: edit }).description).toEqual(edit);
  expect(projectEditSchema.parse({ projectKey: "APP", description: edit }).description).toEqual(
    edit,
  );
  expect(labelEditSchema.parse({ labelName: "bug", description: edit }).description).toEqual(edit);
  expect(commentEditSchema.parse({ commentKey: "APP-1#1", text: edit }).text).toEqual(edit);

  expect(taskEditSchema.parse({ taskKey: "APP-1", description: "  " }).description).toBeNull();
  expect(commentEditSchema.parse({ commentKey: "APP-1#1", text: "Full" }).text).toBe("Full");
  expect(() => commentEditSchema.parse({ commentKey: "APP-1#1", text: " " })).toThrow(
    "Comment text cannot be blank",
  );
  expect(() => commentEditSchema.parse({ commentKey: "APP-1#1", text: { append: " " } })).toThrow(
    "Text to append cannot be blank",
  );
});

test("replace changes the one match in each description field", () => {
  forEachDescriptionField(
    "Keep this. Old sentence. Keep that.",
    `
      const edited = record.edit({ find: "Old sentence.", replace: "New sentence." });
      assert.equal(edited.description, "Keep this. New sentence. Keep that.");
      assert.equal(record.read().text, "Keep this. New sentence. Keep that.");
      assert.deepEqual(record.history().at(-1).changes, {
        description: ["Keep this. Old sentence. Keep that.", "Keep this. New sentence. Keep that."],
      });
    `,
  );
});

test("replace is exact: case, whitespace and line endings are not folded", () => {
  forEachDescriptionField(
    "Line one\r\nLine two  end",
    `
      for (const find of ["line one", "Line one\\nLine two", "Line two end"]) {
        assert.throws(() => record.edit({ find, replace: "x" }), matchError(0, target));
      }
      assert.equal(record.edit({ find: "Line one\\r\\nLine two", replace: "Joined" }).description, "Joined  end");
    `,
  );
});

test("a replace that finds nothing throws a typed error and leaves the record unchanged", () => {
  forEachDescriptionField(
    "Some text",
    `
      const before = record.read();
      const historyBefore = record.history();
      assert.throws(
        () => record.edit({ find: "missing", replace: "x", all: true }),
        (error) => matchError(0, target)(error) && error.message === "The text to replace was not found in " + target + ".",
      );
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);
    `,
  );
});

test("a replace on an absent description finds nothing", () => {
  forEachDescriptionField(
    null,
    `
      assert.throws(() => record.edit({ find: "x", replace: "y" }), matchError(0, target));
      assert.equal(record.read().text, null);
    `,
  );
});

test("several matches need all, and the error carries the count", () => {
  forEachDescriptionField(
    "board, board, board and boards",
    `
      const before = record.read();
      assert.throws(
        () => record.edit({ find: "board", replace: "database" }),
        (error) =>
          matchError(4, target)(error) &&
          error.message === "The text to replace matches 4 places in " + target + ". Include more of the surrounding text so it matches one place.",
      );
      assert.deepEqual(record.read(), before);

      const edited = record.edit({ find: "board", replace: "database", all: true });
      assert.equal(edited.description, "database, database, database and databases");
    `,
  );
});

test("matches do not overlap", () => {
  forEachDescriptionField(
    "aaaa",
    `
      assert.throws(() => record.edit({ find: "aa", replace: "b" }), matchError(2, target));
      assert.equal(record.edit({ find: "aa", replace: "b", all: true }).description, "bb");
    `,
  );
});

test("dollar patterns in the replacement are kept literally", () => {
  forEachDescriptionField(
    "price: TBD",
    `
      assert.equal(record.edit({ find: "TBD", replace: "$& $1 $$ $\`" }).description, "price: $& $1 $$ $\`");
    `,
  );
});

test("replacing with an empty string deletes the match, and a blank result clears a description", () => {
  forEachDescriptionField(
    "First. Stale line. Last.",
    `
      assert.equal(record.edit({ find: " Stale line.", replace: "" }).description, "First. Last.");
      assert.equal(record.edit({ find: "First. Last.", replace: "" }).description, null);
      assert.equal(record.read().text, null);
      assert.deepEqual(record.history().at(-1).changes, { description: ["First. Last.", null] });
    `,
  );
});

test("append adds one paragraph, dropping trailing line breaks of the existing text", () => {
  forEachDescriptionField(
    "First paragraph.",
    `
      assert.equal(record.edit({ append: "Second." }).description, "First paragraph.\\n\\nSecond.");
      assert.equal(record.read().text, "First paragraph.\\n\\nSecond.");
      assert.deepEqual(record.history().at(-1).changes, {
        description: ["First paragraph.", "First paragraph.\\n\\nSecond."],
      });
    `,
  );

  forEachDescriptionField(
    "Ends with breaks.\r\n\n\r\n",
    `
      assert.equal(record.edit({ append: "  Indented stays." }).description, "Ends with breaks.\\n\\n  Indented stays.");
    `,
  );
});

test("append to an absent description sets it to the appended text", () => {
  forEachDescriptionField(
    null,
    `
      assert.equal(record.edit({ append: "Fresh." }).description, "Fresh.");
      assert.equal(record.read().text, "Fresh.");
      assert.deepEqual(record.history().at(-1).changes, { description: [null, "Fresh."] });
    `,
  );
});

test("blank append and empty find are validation errors", () => {
  forEachDescriptionField(
    "Text",
    `
      assert.throws(() => record.edit({ append: " \\n" }), /Text to append cannot be blank/);
      assert.throws(() => record.edit({ find: "", replace: "x" }), /Text to find cannot be empty/);
      assert.throws(() => record.edit({ append: "x", find: "Text", replace: "y" }));
      assert.equal(record.read().text, "Text");
    `,
  );
});

test("an edit whose result equals the current text writes nothing and records no activity", () => {
  forEachDescriptionField(
    "Same text",
    `
      const before = record.read();
      const historyBefore = record.history();
      const unchanged = record.edit({ find: "Same", replace: "Same" });
      assert.equal(unchanged.description, "Same text");
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);
    `,
  );
});

test("comment text edits follow the same rules and record the full before and after", () => {
  runTextEditCheck(`
    task.create({ project_id: app.id, title: "Task", description: null }, human);
    comment.create({ taskKey: "APP-1", text: "Deploy on Friday. Deploy early." }, human);
    const history = () => task.activity("APP-1").filter((row) => row.action === "comment_edit");
    const target = "comment APP-1#1";

    assert.throws(() => comment.edit({ commentKey: "APP-1#1", text: { find: "Monday", replace: "x" } }, human), matchError(0, target));
    assert.throws(() => comment.edit({ commentKey: "APP-1#1", text: { find: "Deploy", replace: "Ship" } }, human), matchError(2, target));
    assert.equal(history().length, 0);

    const replaced = comment.edit({ commentKey: "APP-1#1", text: { find: "Deploy", replace: "Ship", all: true } }, human);
    assert.equal(replaced.text, "Ship on Friday. Ship early.");
    assert.equal(replaced.key, "APP-1#1");
    assert.equal(comment.getByKey("APP-1#1").text, "Ship on Friday. Ship early.");
    assert.deepEqual(history().at(-1).changes.text, ["Deploy on Friday. Deploy early.", "Ship on Friday. Ship early."]);

    const appended = comment.edit({ commentKey: "APP-1#1", text: { append: "Done.\\n" } }, human);
    assert.equal(appended.text, "Ship on Friday. Ship early.\\n\\nDone.\\n");
    assert.equal(
      comment.edit({ commentKey: "APP-1#1", text: { append: "More." } }, human).text,
      "Ship on Friday. Ship early.\\n\\nDone.\\n\\nMore.",
    );

    const money = comment.edit({ commentKey: "APP-1#1", text: { find: "Done.", replace: "$&$&" } }, human);
    assert.ok(money.text.includes("$&$&"));

    assert.deepEqual(task.search({ query: "early" }).tasks.map((row) => row.key), ["APP-1"]);
  `);
});

test("a comment replace that blanks the text is rejected and a no-op records nothing", () => {
  runTextEditCheck(`
    task.create({ project_id: app.id, title: "Task", description: null }, human);
    comment.create({ taskKey: "APP-1", text: "Only this" }, human);
    const history = () => task.activity("APP-1").filter((row) => row.action === "comment_edit");
    const readRow = () => getDb().query("SELECT text, updated_at FROM comment").get();
    const before = readRow();

    assert.throws(
      () => comment.edit({ commentKey: "APP-1#1", text: { find: "Only this", replace: " " } }, human),
      /Comment text cannot be blank/,
    );
    assert.throws(() => comment.edit({ commentKey: "APP-1#1", text: { append: "  " } }, human), /Text to append cannot be blank/);
    assert.deepEqual(readRow(), before);

    const unchanged = comment.edit({ commentKey: "APP-1#1", text: { find: "Only", replace: "Only" } }, human);
    assert.equal(unchanged.text, "Only this");
    assert.deepEqual(readRow(), before);
    assert.equal(history().length, 0);
  `);
});

test("a no-op description edit does not advance updated_at", () => {
  runTextEditCheck(`
    const created = task.create({ project_id: app.id, title: "Task", description: "Alpha beta" }, human);
    const unchanged = task.edit({ taskKey: "APP-1", description: { find: "beta", replace: "beta" } }, human);
    assert.equal(unchanged.updated_at, created.updated_at);
    assert.equal(task.activity("APP-1").length, 1);

    const changed = task.edit({ taskKey: "APP-1", description: { find: "beta", replace: "gamma" } }, human);
    assert.ok(changed.updated_at >= created.updated_at);
    assert.equal(task.activity("APP-1").length, 2);
    assert.deepEqual(task.search({ query: "gamma" }).tasks.map((row) => row.key), ["APP-1"]);
    assert.deepEqual(task.search({ query: "beta" }).tasks, []);
  `);
});
