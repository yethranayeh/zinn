import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Activity } from "@zinn-dev/core";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { runProcessAsync, runZinn, withIsolatedZinnDir } from "../test-helpers";

// ZINN-461: pins how activity text navigation identifies tasks, projects and columns
// from history outside the displayed page, so later read changes are checked against it.

type FixtureIds = Record<
  | "oldProject" | "newProject" | "old1" | "old2" | "old3"
  | "new1" | "new2" | "new3" | "new4" | "new5" | "extraColumn" | "stagingColumn",
  string
>;

type Row = { event: Activity; identity: string; continuation: Array<string> };

const CORE_PATH = join(import.meta.dir, "../../core/index.ts");

// Two lifetimes of project APP. The first is deleted with its tasks, so keys APP-1 to APP-3 are reused.
const FIXTURE_SCRIPT = `
  import { column, project, task } from ${JSON.stringify(CORE_PATH)};
  const actor = { name: "Test", email: null, kind: "human" };
  const session = (sessionId) => ({ ...actor, sessionId });
  const create = (projectId, title) => task.create({ project_id: projectId, title }, actor).id;
  const oldProject = project.create({ key: "APP" }, actor).id;
  const old1 = create(oldProject, "Old one");
  const old2 = create(oldProject, "Old two");
  const old3 = create(oldProject, "Old three");
  const extraColumn = column.create({ projectKey: "APP", name: "Extra" }, actor).id;
  column.edit({ projectKey: "APP", columnName: "Extra", name: "Extra renamed" }, session("old-column-edit"));
  project.edit({ projectKey: "APP", name: "Old name" }, session("old-project-edit"));
  task.delete("APP-2", actor);
  project.delete("APP", session("old-project-delete"));
  const newProject = project.create({ key: "APP" }, actor).id;
  const new1 = create(newProject, "New one");
  const new2 = create(newProject, "New two");
  const new3 = create(newProject, "New three");
  const new4 = create(newProject, "Never reused");
  const new5 = create(newProject, "Deleted unique");
  const stagingColumn = column.create({ projectKey: "APP", name: "Staging" }, actor).id;
  column.edit({ projectKey: "APP", columnName: "Staging", name: "Staging two" }, session("new-column-edit"));
  column.delete({ projectKey: "APP", columnName: "Staging two" }, actor);
  task.delete("APP-5", actor);
  task.edit({ taskKey: "APP-3", title: "New three edited" }, session("deleted-edit"));
  task.delete("APP-3", actor);
  task.edit({ taskKey: "APP-1", title: "New one edited" }, session("live-edit"));
  console.log(JSON.stringify({ oldProject, newProject, old1, old2, old3, new1, new2, new3, new4, new5, extraColumn, stagingColumn }));
`;

async function withNavigationFixture(
  run: (fixture: { ids: FixtureIds; rows: (...flags: Array<string>) => Promise<Array<Row>> }) => Promise<void>,
) {
  await withIsolatedZinnDir(async (directory) => {
    const built = await runProcessAsync([process.execPath, "--eval", FIXTURE_SCRIPT], {
      cwd: directory,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory },
    });
    expect(built.code, built.stderr).toBe(0);
    const ids: FixtureIds = JSON.parse(built.stdout);

    // Pairs each text row with the event the same command returns as JSON.
    const rows = async (...flags: Array<string>) => {
      const json = await runZinn(["activity", "list", ...flags, "--json"], directory);
      const text = await runZinn(["activity", "list", ...flags], directory);
      expect(json.code, json.stderr).toBe(0);
      expect(text.code, text.stderr).toBe(0);
      const events: Array<Activity> = JSON.parse(json.stdout);
      const blocks = text.stdout.trimEnd().split(/\n(?=\S)/).filter((block) => block.length > 0);
      expect(blocks).toHaveLength(events.length);
      return blocks.map((block, index) => {
        const [first, ...continuation] = block.split("\n");
        const event = events[index]!;
        expect(event.id.startsWith(first!.split(" ")[0]!)).toBe(true);
        return { event, identity: first!.split(" · ")[0]!, continuation };
      });
    };
    await run({ ids, rows });
  });
}

function rowsFor(rows: Array<Row>, entityId: string) {
  const selected = rows.filter((row) => row.event.entity_id === entityId);
  expect(selected.length).toBeGreaterThan(0);
  return selected;
}

/** A task row whose navigation names the key and adds a line carrying the task ID. */
function showsTaskId(row: Row) {
  return row.continuation.some((line) => line.includes(row.event.entity_id));
}

function isDeleted(row: Row) {
  return row.identity.includes("deleted");
}

test("project pages add the task ID line only for keys a deletion in the selection recorded and another identity shares", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    const current = await rows("--project", "APP");
    for (const row of rowsFor(current, ids.new1)) {
      expect(row.identity).toContain("APP-1");
      expect(showsTaskId(row)).toBe(false);
    }
    for (const row of rowsFor(current, ids.new2)) {
      expect(showsTaskId(row)).toBe(false);
    }
    for (const row of rowsFor(current, ids.new3)) {
      expect(row.identity).toContain("APP-3");
      expect(isDeleted(row)).toBe(true);
      expect(showsTaskId(row)).toBe(true);
    }
    for (const row of rowsFor(current, ids.new5)) {
      expect(row.identity).toContain("APP-5");
      expect(isDeleted(row)).toBe(true);
      expect(showsTaskId(row)).toBe(false);
    }
    expect(current.some((row) => row.event.entity_id === ids.oldProject)).toBe(false);

    const withDeleted = await rows("--project", "APP", "--show-deleted");
    for (const id of [ids.new1, ids.old1, ids.new2, ids.old2, ids.new3, ids.old3]) {
      for (const row of rowsFor(withDeleted, id)) {
        expect(showsTaskId(row)).toBe(true);
      }
    }
    for (const id of [ids.new4, ids.new5]) {
      for (const row of rowsFor(withDeleted, id)) {
        expect(showsTaskId(row)).toBe(false);
      }
    }
    for (const row of rowsFor(withDeleted, ids.new1)) {
      expect(isDeleted(row)).toBe(false);
    }
    for (const row of rowsFor(withDeleted, ids.old1)) {
      expect(row.identity).toContain("APP-1");
      expect(isDeleted(row)).toBe(true);
    }
    for (const row of rowsFor(withDeleted, ids.oldProject)) {
      expect(row.identity).toContain("APP");
      expect(isDeleted(row)).toBe(true);
    }
    for (const row of rowsFor(withDeleted, ids.newProject)) {
      expect(row.identity).toContain("APP");
      expect(isDeleted(row)).toBe(false);
    }
  });
});

// ZINN-478: global pages check reused keys and deleted tasks across the database, so --limit does not change a row.
test("global pages take reused-key and deleted-task evidence from the whole database", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    const all = await rows();
    for (const row of rowsFor(all, ids.new1)) {
      expect(showsTaskId(row)).toBe(true);
    }
    for (const row of rowsFor(all, ids.new4)) {
      expect(showsTaskId(row)).toBe(false);
    }

    const [newest, ...rest] = await rows("--limit", "1");
    expect(rest).toHaveLength(0);
    expect(newest!.event.entity_id).toBe(ids.new1);
    expect(newest!.identity).toContain("APP-1");
    expect(showsTaskId(newest!)).toBe(true);

    const [deletedEdit] = await rows("--session", "deleted-edit");
    expect(deletedEdit!.event.entity_id).toBe(ids.new3);
    expect(deletedEdit!.identity).toContain("APP-3");
    expect(isDeleted(deletedEdit!)).toBe(true);
    expect(showsTaskId(deletedEdit!)).toBe(true);

    // Every page of a global walk shows each event as the unlimited list does, apart from column padding.
    const normalize = (row: Row) => [row.identity, ...row.continuation].map((line) => line.replace(/\s+/g, " ").trim());
    const expected = new Map(all.map((row) => [row.event.id, normalize(row)]));
    const walked: Array<string> = [];
    let cursor: Array<string> = [];
    do {
      const page = await rows("--limit", "3", ...cursor);
      for (const row of page) {
        expect(normalize(row)).toEqual(expected.get(row.event.id)!);
        walked.push(row.event.id);
      }
      cursor = page.length === 3 ? ["--starting-after", page.at(-1)!.event.id] : [];
    } while (cursor.length > 0);
    expect(walked).toEqual([...expected.keys()]);
  });
});

test("task selections add the task ID line for reused keys and always for exact task IDs", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    for (const row of await rows("--task", "APP-1")) {
      expect(row.event.entity_id).toBe(ids.new1);
      expect(showsTaskId(row)).toBe(true);
    }
    for (const row of await rows("--task", "APP-4")) {
      expect(showsTaskId(row)).toBe(false);
    }

    const lifetimes = await rows("--task", "APP-1", "--show-deleted");
    const taskRows = lifetimes.filter((row) => row.event.entity_type === "task");
    expect(new Set(taskRows.map((row) => row.event.entity_id))).toEqual(new Set([ids.old1, ids.new1]));
    for (const row of taskRows) {
      expect(showsTaskId(row)).toBe(true);
      expect(isDeleted(row)).toBe(row.event.entity_id === ids.old1);
    }

    for (const id of [ids.new4, ids.old1, ids.new5]) {
      const selected = await rows("--task-id", id);
      expect(selected.length).toBeGreaterThan(0);
      for (const row of selected.filter((entry) => entry.event.entity_type === "task")) {
        expect(showsTaskId(row)).toBe(true);
        expect(isDeleted(row)).toBe(id !== ids.new4);
      }
    }
  });
});

test("project selections name deleted projects and columns from their snapshots and global output does not", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    // The project deletion's column snapshot is newer than the column's own create event.
    for (const selector of [["--project-id", ids.oldProject], ["--project", "APP", "--show-deleted"]]) {
      const [extra] = await rows(...selector, "--session", "old-column-edit");
      expect(extra!.event.entity_id).toBe(ids.extraColumn);
      expect(extra!.identity).toContain("Extra renamed");
      expect(isDeleted(extra!)).toBe(true);

      const [renamedProject] = await rows(...selector, "--session", "old-project-edit");
      expect(renamedProject!.event.entity_id).toBe(ids.oldProject);
      expect(renamedProject!.identity).toContain("APP");
      expect(isDeleted(renamedProject!)).toBe(true);
    }
    const [staging] = await rows("--project", "APP", "--session", "new-column-edit");
    expect(staging!.event.entity_id).toBe(ids.stagingColumn);
    expect(staging!.identity).toContain("Staging two");
    expect(isDeleted(staging!)).toBe(true);

    for (const [session, id, name] of [
      ["old-column-edit", ids.extraColumn, "Extra"],
      ["old-project-edit", ids.oldProject, "APP"],
      ["new-column-edit", ids.stagingColumn, "Staging"],
    ] as const) {
      const [row] = await rows("--session", session);
      expect(row!.event.entity_id).toBe(id);
      expect(row!.identity).not.toContain(name);
      expect(isDeleted(row!)).toBe(true);
    }
  });
});

test("a project deletion lists the tasks it removed under project selections only", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    for (const selector of [["--project-id", ids.oldProject], ["--project", "APP", "--show-deleted"]]) {
      const [deletion] = await rows(...selector, "--session", "old-project-delete");
      expect(deletion!.event).toMatchObject({ entity_id: ids.oldProject, action: "delete" });
      const lines = deletion!.continuation.join("\n");
      expect(lines).toContain(ids.old1);
      expect(lines).toContain(ids.old3);
      expect(lines).not.toContain(ids.old2);
    }
    const [global] = await rows("--session", "old-project-delete");
    const lines = global!.continuation.join("\n");
    expect(lines).not.toContain(ids.old1);
    expect(lines).not.toContain(ids.old3);
  });
});

test("project navigation keeps evidence from outside the page and the filters on continuation pages", async () => {
  await withNavigationFixture(async ({ ids, rows }) => {
    const [filtered] = await rows("--project", "APP", "--session", "deleted-edit");
    expect(filtered!.event.entity_id).toBe(ids.new3);
    expect(filtered!.identity).toContain("APP-3");
    expect(isDeleted(filtered!)).toBe(true);
    expect(showsTaskId(filtered!)).toBe(true);

    const [deletion] = (await rows("--task-id", ids.new3, "--action", "delete")).map((row) => row.event);
    const [continued] = await rows("--project", "APP", "--starting-after", deletion!.id, "--limit", "1");
    expect(continued!.event.id).toBe(filtered!.event.id);
    expect(continued!.identity).toContain("APP-3");
    expect(showsTaskId(continued!)).toBe(true);
    const [globalContinued] = await rows("--starting-after", deletion!.id, "--limit", "1");
    expect(globalContinued!.event.id).toBe(filtered!.event.id);
    expect(globalContinued!.identity).toContain("APP-3");

    // Every page of a project walk shows each event as the unlimited list does, apart from column padding.
    const normalize = (row: Row) => [row.identity, ...row.continuation].map((line) => line.replace(/\s+/g, " ").trim());
    for (const selector of [["--project", "APP"], ["--project", "APP", "--show-deleted"], ["--project-id", ids.oldProject]]) {
      const expected = new Map((await rows(...selector)).map((row) => [row.event.id, normalize(row)]));
      const walked: Array<string> = [];
      let cursor: Array<string> = [];
      do {
        const page = await rows(...selector, "--limit", "3", ...cursor);
        for (const row of page) {
          expect(normalize(row)).toEqual(expected.get(row.event.id)!);
          walked.push(row.event.id);
        }
        cursor = page.length === 3 ? ["--starting-after", page.at(-1)!.event.id] : [];
      } while (cursor.length > 0);
      expect(walked).toEqual([...expected.keys()]);
    }
  });
});

// ZINN-413: a page reads only its selection and the identity evidence its events need.
test("activity pages and their text navigation read no unrelated history", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const result = await runProcessAsync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { spyOn } from "bun:test";
      import { activity, project, task } from ${JSON.stringify(CORE_PATH)};
      import * as dbActivity from ${JSON.stringify(join(import.meta.dir, "../../core/src/db/activity.ts"))};
      import { presentActivities } from ${JSON.stringify(join(import.meta.dir, "../src/presentation/activity-presentation.ts"))};
      const actor = { name: "Test", email: null, kind: "human" };
      const create = (projectId, title) => task.create({ project_id: projectId, title }, actor);
      const oldProject = project.create({ key: "APP" }, actor);
      create(oldProject.id, "Old one");
      create(oldProject.id, "Old two");
      task.delete("APP-2", actor);
      project.delete("APP", actor);
      // Unrelated deletions outnumber every read the selections below need.
      const unrelatedDeletions = 60;
      const noise = project.create({ key: "NOISE" }, actor);
      for (let index = 0; index < unrelatedDeletions; index++) {
        task.delete(create(noise.id, "Noise " + index).key, actor);
      }
      const app = project.create({ key: "APP" }, actor);
      const one = create(app.id, "One");
      create(app.id, "Two");
      task.delete("APP-2", actor);
      task.edit({ taskKey: "APP-1", title: "One edited" }, actor);

      const reads = Object.keys(dbActivity)
        .filter((name) => name.startsWith("get") && name !== "getIds")
        .map((name) => spyOn(dbActivity, name));
      const selections = [{}, { actions: ["delete"] }, { projectKey: "APP" }, { projectKey: "APP", showDeleted: true },
        { projectId: oldProject.id }, { taskKey: "APP-1" }, { taskKey: "APP-1", showDeleted: true }, { taskId: one.id }];
      for (const selection of selections) {
        for (const read of reads) {
          read.mockClear();
        }
        const { actions, ...selector } = selection;
        const page = activity.getAll({ ...selection, limit: 3 });
        assert.ok(page.events.length > 0);
        presentActivities(page.events, selector);
        const rowsRead = reads.flatMap((read) => read.mock.results).reduce((total, { value }) => total + value.length, 0);
        assert.ok(rowsRead < unrelatedDeletions, JSON.stringify(selection) + " read " + rowsRead + " rows");
      }
    `], { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
    expect(result.code, result.stderr).toBe(0);
  });
});

// ZINN-478: a page reads deleted task identities for all its keys at once.
test("a global deletion page reads task deletions once for all its keys", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const result = await runProcessAsync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { spyOn } from "bun:test";
      import { activity, project, task } from ${JSON.stringify(CORE_PATH)};
      import * as dbActivity from ${JSON.stringify(join(import.meta.dir, "../../core/src/db/activity.ts"))};
      import { presentActivities } from ${JSON.stringify(join(import.meta.dir, "../src/presentation/activity-presentation.ts"))};
      const actor = { name: "Test", email: null, kind: "human" };
      const old = project.create({ key: "APP" }, actor);
      task.create({ project_id: old.id, title: "Old one" }, actor);
      project.delete("APP", actor);
      const app = project.create({ key: "APP" }, actor);
      const deletedTasks = 10;
      for (let index = 0; index < deletedTasks; index++) {
        task.delete(task.create({ project_id: app.id, title: "Deleted " + index }, actor).key, actor);
      }

      const deletionReads = spyOn(dbActivity, "getTaskDeletionEvents");
      const page = activity.getAll({ actions: ["delete"], limit: deletedTasks }).events;
      assert.equal(page.length, deletedTasks);
      const presented = presentActivities(page);
      assert.equal(deletionReads.mock.calls.length, 1);
      assert.deepEqual(presented.filter((entry) => entry.navigation.distinguishesTaskId).map((entry) => entry.navigation.name), ["APP-1"]);
    `], { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
    expect(result.code, result.stderr).toBe(0);
  });
});

// ZINN-478: a project page and its navigation share one membership read until the database changes.
test("a project page resolves membership once and again after any write", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const result = await runProcessAsync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { execFileSync } from "node:child_process";
      import { spyOn } from "bun:test";
      import { activity, project, task } from ${JSON.stringify(CORE_PATH)};
      import * as dbActivity from ${JSON.stringify(join(import.meta.dir, "../../core/src/db/activity.ts"))};
      import { presentActivities } from ${JSON.stringify(join(import.meta.dir, "../src/presentation/activity-presentation.ts"))};
      const actor = { name: "Test", email: null, kind: "human" };
      const app = project.create({ key: "APP" }, actor);
      task.create({ project_id: app.id, title: "One" }, actor);

      const membershipReads = spyOn(dbActivity, "getTaskIdsRecordedInColumns");
      const page = () => {
        membershipReads.mockClear();
        const events = activity.getAll({ projectKey: "APP", limit: 20 }).events;
        presentActivities(events, { projectKey: "APP" });
        assert.equal(membershipReads.mock.calls.length, 1);
        return events;
      };
      page();
      task.create({ project_id: app.id, title: "Two" }, actor);
      assert.ok(page().some((event) => event.changes?.title === "Two"));
      execFileSync(process.execPath, [${JSON.stringify(join(import.meta.dir, "../index.ts"))}, "task", "create", "APP", "--title", "Three"], { env: process.env });
      assert.ok(page().some((event) => event.changes?.title === "Three"));
    `], { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
    expect(result.code, result.stderr).toBe(0);
  });
});
