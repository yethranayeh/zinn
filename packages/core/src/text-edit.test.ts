import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { comment, InputValidationError, label, MAX_TEXT_BYTES, project, task, TextEditMatchError } from "../index";
import { getDb } from "./db";
import * as dbActivity from "./db/activity";
import { CoreError } from "./errors";
import { commentEditSchema } from "./schemas/comment";
import { labelEditSchema } from "./schemas/label";
import { projectEditSchema } from "./schemas/project";
import { taskEditSchema } from "./schemas/task";
import { textEditSchema } from "./schemas/text-edit";
import { withTestStore } from "./testing";

// ZINN-177: partial edits of descriptions and comment text.

function fixtures() {
  const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
  const app = project.create({ key: "APP" }, human);
  const matchError = (count: number, target: string) => (error: unknown) =>
    error instanceof TextEditMatchError && error.matchCount === count && error.target === target;
  // Each description field, as one editable record with read, edit and history access.
  const fields = [
    {
      target: "APP-1's description",
      make: (description: string | null) => {
        task.create({ project_id: app.id, title: "Task", description }, human);
        return {
          edit: (description: Parameters<typeof task.edit>[0]["description"]) => task.edit({ taskKey: "APP-1", description }, human).task,
          read: () => getDb().query<{ text: string | null; updated_at: number }>("SELECT description AS text, updated_at FROM task WHERE title = 'Task'").get(),
          history: () => task.activity("APP-1"),
        };
      },
    },
    {
      target: "project PRJ's description",
      make: (description: string | null) => {
        project.create({ key: "PRJ", description }, human);
        return {
          edit: (description: Parameters<typeof task.edit>[0]["description"]) => project.edit({ projectKey: "PRJ", description }, human),
          read: () => getDb().query<{ text: string | null; updated_at: number }>("SELECT description AS text, updated_at FROM project WHERE key = 'PRJ'").get(),
          history: () => dbActivity.getAllByEntity("project", project.getByKey("PRJ")!.id),
        };
      },
    },
    {
      target: "label bug's description",
      make: (description: string | null) => {
        const created = label.create({ name: "bug", description }, human);
        return {
          edit: (description: Parameters<typeof task.edit>[0]["description"]) => label.edit({ labelName: "bug", description }, human),
          read: () => getDb().query<{ text: string | null; updated_at: number }>("SELECT description AS text, 0 AS updated_at FROM label WHERE name = 'bug'").get(),
          history: () => dbActivity.getAllByEntity("label", created.id),
        };
      },
    },
  ];
  return { human, app, matchError, fields };
}

function runTextEditCheck(check: (context: ReturnType<typeof fixtures>) => void) {
  withTestStore(() => check(fixtures()));
}

/** Runs `body` once per description field, each with a fresh record made from `initial`. */
function forEachDescriptionField(initial: string | null, body: (record: ReturnType<ReturnType<typeof fixtures>["fields"][number]["make"]>, target: string, matchError: ReturnType<typeof fixtures>["matchError"]) => void) {
  runTextEditCheck(({ matchError, fields }) => {
    for (const field of fields) {
      const record = field.make(initial);
      const target = field.target;
      body(record, target, matchError);
      // The next field reuses the same task, project and label names.
      getDb().exec("DELETE FROM task; DELETE FROM label; DELETE FROM project WHERE key != 'APP'");
    }
  });
}

test("oversized description edits preserve the entity, timestamp, activity and search records", () => {
  runTextEditCheck(({ fields }) => {

    const atLimit = "a".repeat(MAX_TEXT_BYTES - 4) + "😀";
    for (const field of fields) {
      const record = field.make(atLimit);
      const before = record.read();
      const history = record.history();
      const search = getDb().query("SELECT * FROM task_search ORDER BY rowid").all();
      for (const edit of [atLimit + "a", { append: "x" }, { find: "😀", replace: "😀x" }]) {
        assert.throws(() => record.edit(edit), InputValidationError);
        assert.deepEqual(record.read(), before);
        assert.deepEqual(record.history(), history);
        assert.deepEqual(getDb().query("SELECT * FROM task_search ORDER BY rowid").all(), search);
      }
      const shortened = record.edit({ find: "😀", replace: "" });
      assert.equal(shortened.description!.length, MAX_TEXT_BYTES - 4);
      getDb().exec("DELETE FROM task; DELETE FROM label; DELETE FROM project WHERE key != 'APP'");
    }
  });
});

test("oversized comment edits preserve text, timestamp, activity and search records", () => {
  runTextEditCheck(({ human, app }) => {

    task.create({ project_id: app.id, title: "Task" }, human);
    const atLimit = "a".repeat(MAX_TEXT_BYTES - 4) + "😀";
    comment.create({ taskKey: "APP-1", text: atLimit }, human);
    const before = comment.getByKey("APP-1#1");
    const history = task.activity("APP-1");
    const search = getDb().query("SELECT * FROM task_search ORDER BY rowid").all();
    for (const text of [atLimit + "a", { append: "x" }, { find: "😀", replace: "😀x" }]) {
      assert.throws(() => comment.edit({ commentKey: "APP-1#1", text }, human), InputValidationError);
      assert.deepEqual(comment.getByKey("APP-1#1"), before);
      assert.deepEqual(task.activity("APP-1"), history);
      assert.deepEqual(getDb().query("SELECT * FROM task_search ORDER BY rowid").all(), search);
    }
    assert.equal(comment.edit({ commentKey: "APP-1#1", text: { find: "😀", replace: "" } }, human).text.length, MAX_TEXT_BYTES - 4);
  });
});

test("unrelated edits allow existing oversized descriptions", () => {
  runTextEditCheck(({ human, app }) => {

    task.create({ project_id: app.id, title: "Task" }, human);
    label.create({ name: "bug" }, human);
    const oversized = "a".repeat(MAX_TEXT_BYTES + 1);
    for (const table of ["project", "task", "label"]) {
      getDb().query("UPDATE " + table + " SET description = ?").run(oversized);
    }
    assert.equal(project.edit({ projectKey: "APP", name: "Renamed" }, human).description, oversized);
    assert.equal(task.edit({ taskKey: "APP-1", title: "Renamed" }, human).task.description, oversized);
    assert.equal(label.edit({ labelName: "bug", color: "red" }, human).description, oversized);
  });
});

test("text edit schema accepts one append or one find/replace and nothing else", () => {
  expect(textEditSchema.parse({ append: "More" })).toEqual({ append: "More" });
  expect(textEditSchema.parse({ find: "a", replace: "" })).toEqual({ find: "a", replace: "" });
  expect(textEditSchema.parse({ find: "a", replace: "b", all: true })).toEqual({
    find: "a",
    replace: "b",
    all: true,
  });

  expect(textEditSchema.safeParse({ append: "  \n" }).error?.issues).toMatchObject([{ path: ["append"] }]);
  expect(textEditSchema.safeParse({ find: "", replace: "b" }).error?.issues).toMatchObject([{ path: ["find"] }]);
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
  expect(commentEditSchema.safeParse({ commentKey: "APP-1#1", text: " " }).error?.issues).toMatchObject([{ path: ["text"] }]);
  expect(commentEditSchema.safeParse({ commentKey: "APP-1#1", text: { append: " " } }).error?.issues).toMatchObject([{ path: ["text", "append"] }]);
});

test("replace changes the one match in each description field", () => {
  forEachDescriptionField(
    "Keep this. Old sentence. Keep that.",
    (record, target, matchError) => {
      const edited = record.edit({ find: "Old sentence.", replace: "New sentence." });
      assert.equal(edited.description, "Keep this. New sentence. Keep that.");
      assert.equal(record.read()!.text, "Keep this. New sentence. Keep that.");
      assert.deepEqual(record.history().at(-1)!.changes, {
        description: ["Keep this. Old sentence. Keep that.", "Keep this. New sentence. Keep that."],
      });

    },
  );
});

test("replace remains exact for case and whitespace after CRLF normalization", () => {
  forEachDescriptionField(
    "Line one\r\nLine two  end",
    (record, target, matchError) => {
      assert.equal(record.read()!.text, "Line one\nLine two  end");
      for (const find of ["line one", "Line one\rLine two", "Line two end"]) {
        assert.throws(() => record.edit({ find, replace: "x" }), matchError(0, target));
      }
      assert.equal(record.edit({ find: "Line one\r\nLine two", replace: "Joined" }).description, "Joined  end");

    },
  );
});

test("description writes and partial edits normalize before persistence and no-op detection", () => {
  forEachDescriptionField(
    "  First\r\nSecond\nThird\rFourth  ",
    (record, target, matchError) => {
      const normalized = "  First\nSecond\nThird\rFourth  ";
      const before = record.read();
      const historyBefore = record.history();
      assert.equal(before!.text, normalized);
      record.edit("  First\r\nSecond\r\nThird\rFourth  ");
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);
      record.edit({ find: "First\nSecond", replace: "First\r\nSecond" });
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);

      record.edit({ find: "First\nSecond", replace: "Joined\r\nLine" });
      assert.equal(record.read()!.text, "  Joined\nLine\nThird\rFourth  ");
      record.edit({ append: "Tail\r\n  Indent\rEnd" });
      assert.equal(record.read()!.text, "  Joined\nLine\nThird\rFourth  \n\nTail\n  Indent\rEnd");
      record.edit("  Edited\r\nText\rEnd  ");
      assert.equal(record.read()!.text, "  Edited\nText\rEnd  ");
      assert.deepEqual(record.history().at(-1)!.changes!.description, [
        "  Joined\nLine\nThird\rFourth  \n\nTail\n  Indent\rEnd",
        "  Edited\nText\rEnd  ",
      ]);

    },
  );
});

test("comment writes and partial edits normalize before persistence and no-op detection", () => {
  runTextEditCheck(({ human, app }) => {
    task.create({ project_id: app.id, title: "Task" }, human);
    comment.create({ taskKey: "APP-1", text: "  First\r\nSecond\nThird\rEnd  " }, human);
    const read = () => getDb().query<{ text: string; updated_at: number }>("SELECT text, updated_at FROM comment").get();
    const before = read();
    const historyBefore = task.activity("APP-1");
    assert.equal(before!.text, "  First\nSecond\nThird\rEnd  ");
    comment.edit({ commentKey: "APP-1#1", text: "  First\r\nSecond\r\nThird\rEnd  " }, human);
    comment.edit({ commentKey: "APP-1#1", text: { find: "First\r\nSecond", replace: "First\r\nSecond" } }, human);
    assert.deepEqual(read(), before);
    assert.deepEqual(task.activity("APP-1"), historyBefore);
    comment.edit({ commentKey: "APP-1#1", text: { find: "First\nSecond", replace: "Joined\r\nLine" } }, human);
    assert.equal(read()!.text, "  Joined\nLine\nThird\rEnd  ");
    comment.edit({ commentKey: "APP-1#1", text: { append: "Tail\r\n  Indent\rEnd" } }, human);
    assert.equal(read()!.text, "  Joined\nLine\nThird\rEnd  \n\nTail\n  Indent\rEnd");
    comment.edit({ commentKey: "APP-1#1", text: "  Edited\r\nText\rEnd  " }, human);
    assert.equal(read()!.text, "  Edited\nText\rEnd  ");
    assert.deepEqual(task.activity("APP-1").at(-1)!.changes!.text, [
      "  Joined\nLine\nThird\rEnd  \n\nTail\n  Indent\rEnd",
      "  Edited\nText\rEnd  ",
    ]);
  });
});

test("a replace that finds nothing throws a typed error and leaves the record unchanged", () => {
  forEachDescriptionField(
    "Some text",
    (record, target, matchError) => {
      const before = record.read();
      const historyBefore = record.history();
      assert.throws(
        () => record.edit({ find: "missing", replace: "x", all: true }),
        matchError(0, target),
      );
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);

    },
  );
});

test("a replace on an absent description finds nothing", () => {
  forEachDescriptionField(
    null,
    (record, target, matchError) => {
      assert.throws(() => record.edit({ find: "x", replace: "y" }), matchError(0, target));
      assert.equal(record.read()!.text, null);

    },
  );
});

test("several matches need all, and the error carries the count", () => {
  forEachDescriptionField(
    "board, board, board and boards",
    (record, target, matchError) => {
      const before = record.read();
      assert.throws(
        () => record.edit({ find: "board", replace: "database" }),
        matchError(4, target),
      );
      assert.deepEqual(record.read(), before);

      const edited = record.edit({ find: "board", replace: "database", all: true });
      assert.equal(edited.description, "database, database, database and databases");

    },
  );
});

test("matches do not overlap", () => {
  forEachDescriptionField(
    "aaaa",
    (record, target, matchError) => {
      assert.throws(() => record.edit({ find: "aa", replace: "b" }), matchError(2, target));
      assert.equal(record.edit({ find: "aa", replace: "b", all: true }).description, "bb");

    },
  );
});

test("dollar patterns in the replacement are kept literally", () => {
  forEachDescriptionField(
    "price: TBD",
    (record, target, matchError) => {
      assert.equal(record.edit({ find: "TBD", replace: "$& $1 $$ $`" }).description, "price: $& $1 $$ $`");

    },
  );
});

test("replacing with an empty string deletes the match, and a blank result clears a description", () => {
  forEachDescriptionField(
    "First. Stale line. Last.",
    (record, target, matchError) => {
      assert.equal(record.edit({ find: " Stale line.", replace: "" }).description, "First. Last.");
      assert.equal(record.edit({ find: "First. Last.", replace: "" }).description, null);
      assert.equal(record.read()!.text, null);
      assert.deepEqual(record.history().at(-1)!.changes, { description: ["First. Last.", null] });

    },
  );
});

test("append adds one paragraph, dropping trailing line breaks of the existing text", () => {
  forEachDescriptionField(
    "First paragraph.",
    (record, target, matchError) => {
      assert.equal(record.edit({ append: "Second." }).description, "First paragraph.\n\nSecond.");
      assert.equal(record.read()!.text, "First paragraph.\n\nSecond.");
      assert.deepEqual(record.history().at(-1)!.changes, {
        description: ["First paragraph.", "First paragraph.\n\nSecond."],
      });

    },
  );

  forEachDescriptionField(
    "Ends with breaks.\r\n\n\r\n",
    (record, target, matchError) => {
      assert.equal(record.edit({ append: "  Indented stays." }).description, "Ends with breaks.\n\n  Indented stays.");

    },
  );
});

test("append to an absent description sets it to the appended text", () => {
  forEachDescriptionField(
    null,
    (record, target, matchError) => {
      assert.equal(record.edit({ append: "Fresh." }).description, "Fresh.");
      assert.equal(record.read()!.text, "Fresh.");
      assert.deepEqual(record.history().at(-1)!.changes, { description: [null, "Fresh."] });

    },
  );
});

test("blank append and empty find are validation errors", () => {
  forEachDescriptionField(
    "Text",
    (record, target, matchError) => {
      assert.throws(() => record.edit({ append: " \n" }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.includes("append"));
      assert.throws(() => record.edit({ find: "", replace: "x" }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.includes("find"));
      assert.throws(() => record.edit({ append: "x", find: "Text", replace: "y" }));
      assert.equal(record.read()!.text, "Text");

    },
  );
});

test("an edit whose result equals the current text writes nothing and records no activity", () => {
  forEachDescriptionField(
    "Same text",
    (record, target, matchError) => {
      const before = record.read();
      const historyBefore = record.history();
      const unchanged = record.edit({ find: "Same", replace: "Same" });
      assert.equal(unchanged.description, "Same text");
      assert.deepEqual(record.read(), before);
      assert.deepEqual(record.history(), historyBefore);

    },
  );
});

test("comment text edits follow the same rules and record the full before and after", () => {
  runTextEditCheck(({ human, app, matchError }) => {
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
    assert.deepEqual(history().at(-1)!.changes!.text, ["Deploy on Friday. Deploy early.", "Ship on Friday. Ship early."]);

    const appended = comment.edit({ commentKey: "APP-1#1", text: { append: "Done.\n" } }, human);
    assert.equal(appended.text, "Ship on Friday. Ship early.\n\nDone.\n");
    assert.equal(
      comment.edit({ commentKey: "APP-1#1", text: { append: "More." } }, human).text,
      "Ship on Friday. Ship early.\n\nDone.\n\nMore.",
    );

    const money = comment.edit({ commentKey: "APP-1#1", text: { find: "Done.", replace: "$&$&" } }, human);
    assert.ok(money.text.includes("$&$&"));

    assert.deepEqual(task.search({ query: "early" }).tasks.map((row) => row.key), ["APP-1"]);
  });
});

test("a comment replace that blanks the text is rejected and a no-op records nothing", () => {
  runTextEditCheck(({ human, app }) => {
    task.create({ project_id: app.id, title: "Task", description: null }, human);
    comment.create({ taskKey: "APP-1", text: "Only this" }, human);
    const history = () => task.activity("APP-1").filter((row) => row.action === "comment_edit");
    const readRow = () => getDb().query<{ text: string; updated_at: number }>("SELECT text, updated_at FROM comment").get();
    const before = readRow();

    assert.throws(
      () => comment.edit({ commentKey: "APP-1#1", text: { find: "Only this", replace: " " } }, human),
      (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.length === 0,
    );
    assert.throws(() => comment.edit({ commentKey: "APP-1#1", text: { append: "  " } }, human), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field!.includes("append"));
    assert.deepEqual(readRow(), before);

    const unchanged = comment.edit({ commentKey: "APP-1#1", text: { find: "Only", replace: "Only" } }, human);
    assert.equal(unchanged.text, "Only this");
    assert.deepEqual(readRow(), before);
    assert.equal(history().length, 0);
  });
});

test("a no-op description edit does not advance updated_at", () => {
  runTextEditCheck(({ human, app }) => {
    const created = task.create({ project_id: app.id, title: "Task", description: "Alpha beta" }, human);
    const unchanged = task.edit({ taskKey: "APP-1", description: { find: "beta", replace: "beta" } }, human);
    assert.equal(unchanged.task.updated_at, created.updated_at);
    assert.equal(task.activity("APP-1").length, 1);

    const changed = task.edit({ taskKey: "APP-1", description: { find: "beta", replace: "gamma" } }, human);
    assert.ok(changed.task.updated_at >= created.updated_at);
    assert.equal(task.activity("APP-1").length, 2);
    assert.deepEqual(task.search({ query: "gamma" }).tasks.map((row) => row.key), ["APP-1"]);
    assert.deepEqual(task.search({ query: "beta" }).tasks, []);
  });
});
