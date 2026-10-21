import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { comment, label, project, task } from "../index";
import { getDb } from "./db";
import { CoreError } from "./errors";
import { withTestStore } from "./testing";

function fixtures() {
  const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
  const app = project.create({ key: "APP" }, human);
  const create = (title: string, description: string | null = null, projectId = app.id) =>
    task.create({ project_id: projectId, title, description }, human);
  const keys = (query: string, options: Omit<Parameters<typeof task.search>[0], "query"> = {}) => task.search({ query, ...options }).tasks.map((entry) => entry.key);
  return { human, app, create, keys };
}

function runSearchCheck(check: (context: ReturnType<typeof fixtures>) => void) {
  withTestStore(() => check(fixtures()));
}

test("words match as case- and accent-insensitive prefixes, and every word must match", () => {
  runSearchCheck(({ create, keys }) => {
    create("Login flow", "Crash on the Café page");
    create("Logout button", "Résumé upload");
    create("Unrelated", "Nothing here");

    assert.deepEqual(keys("log").sort(), ["APP-1", "APP-2"]);
    assert.deepEqual(keys("LOGIN"), ["APP-1"]);
    assert.deepEqual(keys("cafe"), ["APP-1"]);
    assert.deepEqual(keys("CAFÉ"), ["APP-1"]);
    assert.deepEqual(keys("resume"), ["APP-2"]);
    assert.deepEqual(keys("log crash"), ["APP-1"]);
    assert.deepEqual(keys("  log   crash  "), ["APP-1"]);
    assert.deepEqual(keys("logout crash"), []);
    assert.deepEqual(keys("ogin"), [], "matching starts at word boundaries");
  });
});

test("words can match across title, description and comments of the same task", () => {
  runSearchCheck(({ human, create, keys }) => {
    create("Payment retries", "Uses the queue");
    comment.create({ taskKey: "APP-1", text: "Blocked on the vendor sandbox" }, human);
    comment.create({ taskKey: "APP-1", text: "Second note about webhooks" }, human);
    create("Vendor contract", null);

    assert.deepEqual(keys("sandbox"), ["APP-1"], "a comment match returns its task");
    assert.deepEqual(keys("payment queue sandbox webhooks"), ["APP-1"]);
    assert.deepEqual(keys("vendor"), ["APP-2", "APP-1"], "title matches outrank comment matches");
  });
});

test("a phrase does not match across two comments", () => {
  runSearchCheck(({ human, create, keys }) => {
    create("Across comments", null);
    comment.create({ taskKey: "APP-1", text: "please sign" }, human);
    comment.create({ taskKey: "APP-1", text: "in the morning" }, human);
    create("Within a comment", null);
    comment.create({ taskKey: "APP-2", text: "sign-in fails" }, human);

    assert.deepEqual(keys("sign-in"), ["APP-2"]);
    assert.deepEqual(keys("sign morning"), ["APP-1"], "words still match in separate comments");
  });
});

test("FTS syntax characters in the query are searched as text and never throw", () => {
  runSearchCheck(({ create, keys }) => {
    create("Fix sign-in: retry (again)", 'Quote "this" AND NOT that*');
    create("Other task", "plain text");

    for (const query of ['-', '"', ':', '(', ')', '*', 'AND', 'NOT', 'OR', 'NEAR(a b)', '"unterminated', 'title:fix', '-fix', 'fix*', '^fix', '+', '{a b}', '\\', "'"]) {
      assert.doesNotThrow(() => task.search({ query }), query);
    }

    assert.deepEqual(keys("sign-in"), ["APP-1"]);
    assert.deepEqual(keys("sign-i"), ["APP-1"]);
    assert.deepEqual(keys("(again)"), ["APP-1"]);
    assert.deepEqual(keys('"this"'), ["APP-1"]);
    assert.deepEqual(keys("AND NOT"), ["APP-1"], "operators are ordinary words");
    assert.deepEqual(keys("description:plain"), [], "column filters are not exposed");
    assert.deepEqual(keys("plain -"), ["APP-2"], "words without letters or digits do not narrow results");
    assert.deepEqual(keys("*"), []);
  });
});

test("an exact task key is pinned first, followed by text matches", () => {
  runSearchCheck(({ app, create, keys }) => {
    create("Parser", null);
    create("Depends on app-1 landing", null);
    create("Other", "mentions APP-1 twice: app-1");

    const [pinned, ...rest] = keys("app-1");
    assert.equal(pinned, "APP-1");
    assert.deepEqual(rest.sort(), ["APP-2", "APP-3"], "text mentioning the key still matches");
    assert.deepEqual(keys(" APP-2 "), ["APP-2"]);
    assert.deepEqual(keys("APP-99"), [], "an unknown key is only text");
    assert.deepEqual(keys("NOPE-1"), []);
    assert.deepEqual(keys("parser"), ["APP-1"]);
  });
});

test("ties break by project key, then task number", () => {
  runSearchCheck(({ human, app, create, keys }) => {
    const zed = project.create({ key: "ZED" }, human);
    const bee = project.create({ key: "BEE" }, human);
    create("Same words", null, zed.id);
    create("Same words", null, app.id);
    create("Same words", null, bee.id);
    create("Same words", null, app.id);

    assert.deepEqual(keys("same"), ["APP-1", "APP-2", "BEE-1", "ZED-1"]);
  });
});

test("archived matches are hidden by default and counted", () => {
  runSearchCheck(({ human, create }) => {
    create("Active widget", null);
    create("Archived widget", null);
    create("Another archived widget", null);
    task.archive("APP-2", human);
    task.archive("APP-3", human);

    const active = task.search({ query: "widget" });
    assert.deepEqual(active.tasks.map((entry) => entry.key), ["APP-1"]);
    assert.equal(active.hiddenArchivedCount, 2);

    const archived = task.search({ query: "widget", archive: "archived" });
    assert.deepEqual(archived.tasks.map((entry) => entry.key).sort(), ["APP-2", "APP-3"]);
    assert.equal(archived.hiddenArchivedCount, 0);

    const all = task.search({ query: "widget", archive: "all" });
    assert.equal(all.tasks.length, 3);
    assert.equal(all.hiddenArchivedCount, 0);

    const pinnedArchived = task.search({ query: "APP-2" });
    assert.deepEqual(pinnedArchived.tasks, []);
    assert.equal(pinnedArchived.hiddenArchivedCount, 1, "a hidden archived key match is counted");
    assert.equal(task.search({ query: "active", limit: 1 }).hiddenArchivedCount, 0);
  });
});

test("project filter, limit, and result shape", () => {
  runSearchCheck(({ human, app, create, keys }) => {
    const other = project.create({ key: "OTHER" }, human);
    create("Shared term one", null);
    create("Shared term two", null);
    create("Shared term elsewhere", null, other.id);

    assert.deepEqual(keys("shared", { projectKey: "other" }), ["OTHER-1"]);
    assert.deepEqual(keys("OTHER-1", { projectKey: "APP" }), [], "a pinned key outside the project is left out");
    assert.throws(() => task.search({ query: "shared", projectKey: "MISSING" }), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "project" && error.facts.key === "MISSING");

    assert.equal(keys("shared").length, 3);
    assert.equal(keys("shared", { limit: 2 }).length, 2);
    assert.deepEqual(keys("app-2", { limit: 1 }), ["APP-2"], "the pinned key counts toward the limit");

    const [result] = task.search({ query: "one" }).tasks;
    assert.deepEqual(result, { ...task.getByKey("APP-1") });
    assert.equal("project_key" in result, false);
  });
});

test("label filters apply before archive counting and limits", () => {
  runSearchCheck(({ human, create, keys }) => {
    label.create({ name: "bug" }, human);
    label.create({ name: "Groom" }, human);
    label.create({ name: "later" }, human);
    const first = create("Widget first");
    const second = create("Widget second");
    const third = create("Widget third");
    task.label.add({ taskKey: first.key, labelNames: ["bug", "Groom"] }, human);
    task.label.add({ taskKey: second.key, labelNames: ["bug"] }, human);
    task.label.add({ taskKey: third.key, labelNames: ["Groom", "later"] }, human);
    task.archive(second.key, human);

    const bugMatches = task.search({ query: "widget", labelNames: ["BUG"] });
    assert.deepEqual(bugMatches.tasks.map((entry) => entry.key), ["APP-1"]);
    assert.equal(bugMatches.hiddenArchivedCount, 1);

    const bothMatches = task.search({ query: "widget", labelNames: ["bug", "groom", "BUG"] });
    assert.deepEqual(bothMatches.tasks.map((entry) => entry.key), ["APP-1"]);
    assert.equal(bothMatches.hiddenArchivedCount, 0);
    assert.deepEqual(keys("APP-3", { labelNames: ["bug"] }), []);
    assert.deepEqual(keys("widget", { labelNames: ["later"], limit: 1 }), ["APP-3"]);
    assert.throws(() => task.search({ query: "widget", labelNames: ["missing"] }), (error) => error instanceof CoreError && error.kind === "missing" && error.facts.entity === "label" && error.facts.key === "missing");
  });
});

test("search input is validated", () => {
  runSearchCheck(({ create }) => {
    create("Anything", null);
    assert.throws(() => task.search({ query: "" }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "query");
    assert.throws(() => task.search({ query: " \t\n" }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "query");
    assert.throws(() => task.search({ query: "a", limit: 0 }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "limit");
    assert.throws(() => task.search({ query: "a", limit: 1.5 }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "limit");
    assert.throws(() => task.search({ query: "a", limit: Number.NaN }), (error) => error instanceof CoreError && error.kind === "input" && error.facts.field![0] === "limit");
    // @ts-expect-error Exercise runtime validation of invalid input.
    assert.throws(() => task.search({ query: "a", archive: "done" }));
    // @ts-expect-error Exercise runtime validation of invalid input.
    assert.throws(() => task.search({ query: "a", column: "TODO" }));
  });
});

test("the index follows task and comment edits and deletions", () => {
  runSearchCheck(({ human, create, keys }) => {
    const db = getDb();
    const indexRows = () => db.query<{ count: number }>("SELECT COUNT(*) AS count FROM task_search").get()!.count;

    create("Original title", "original body");
    create("Neighbour", null);
    assert.equal(indexRows(), 2);

    task.edit({ taskKey: "APP-1", title: "Renamed heading" }, human);
    assert.deepEqual(keys("original"), ["APP-1"], "the description is still indexed");
    assert.deepEqual(keys("original title"), []);
    assert.deepEqual(keys("renamed"), ["APP-1"]);

    task.edit({ taskKey: "APP-1", description: null }, human);
    assert.deepEqual(keys("original"), []);

    task.move({ taskKey: "APP-1", targetColumn: "TODO" }, human);
    task.edit({ taskKey: "APP-1", priority: "high" }, human);
    assert.deepEqual(keys("renamed"), ["APP-1"]);

    const created = comment.create({ taskKey: "APP-1", text: "Needs a flamingo" }, human);
    comment.create({ taskKey: "APP-1", text: "Also a walrus" }, human);
    assert.deepEqual(keys("flamingo walrus"), ["APP-1"]);

    comment.edit({ commentKey: created.key, text: "Needs a pelican" }, human);
    assert.deepEqual(keys("flamingo"), []);
    assert.deepEqual(keys("pelican walrus"), ["APP-1"]);

    comment.delete({ commentKey: "APP-1#2" }, human);
    assert.deepEqual(keys("walrus"), []);
    assert.deepEqual(keys("pelican renamed"), ["APP-1"]);
    assert.equal(indexRows(), 2);

    task.delete("APP-1", human);
    assert.deepEqual(keys("pelican"), []);
    assert.deepEqual(keys("renamed"), []);
    assert.equal(indexRows(), 1);

    project.delete("APP", human);
    assert.equal(indexRows(), 0);
  });
});

test("a task missing from the index, as in an older database, is indexed when it changes", () => {
  runSearchCheck(({ human, create, keys }) => {
    create("Legacy task", null);
    comment.create({ taskKey: "APP-1", text: "old remark" }, human);
    getDb().exec("DELETE FROM task_search");
    assert.deepEqual(keys("legacy"), []);

    comment.create({ taskKey: "APP-1", text: "new remark" }, human);
    assert.deepEqual(keys("legacy old new"), ["APP-1"]);
  });
});
