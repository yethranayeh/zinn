import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Activity } from "@zinn-dev/core";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { routes } from "../src/routes/routes";
import { CLI_PATH, createEmptyDatabase, runProcessAsync, runZinn, runZinnAs, seedRecordedActivity, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("activity empty lists and unrecoverable task histories return empty results", async () => {
  await withIsolatedZinnDir(async (directory) => {
    createEmptyDatabase(directory);
    for (const args of [["activity", "list"], ["activity", "list", "--task", "gone-2", "--show-deleted"], ["activity", "list", "--task-id", "ffffffff-ffff-7fff-8fff-ffffffffffff"]]) {
      const text = await runZinn(args, directory);
      expect(text).toEqual({ code: 0, stdout: "", stderr: "" });
      const json = await runZinn([...args, "--json"], directory);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
    }
  });
});

test("activity task-key selection refuses missing current tasks with explicit deleted-history guidance", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Deleted task")).code).toBe(0);
    expect((await run("task", "delete", "APP-1", "--yes")).code).toBe(0);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const key of ["app-1", "APP-99", "GONE-1"]) {
      const result = await run("activity", "list", "--task", key, "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const failure = JSON.parse(result.stderr).error;
      expect(failure.code).toBe("not_found");
      expect(failure.details).toMatchObject({ entity: "task", key: key.toUpperCase(), argument: "--task" });
      expect(failure.help).toContain("--show-deleted");
      expect(failure.help).toContain(key);
      const text = await run("activity", "list", "--task", key);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("--show-deleted");
    }
    const history = await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json");
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout).map((event: Activity) => event.action)).toEqual(["delete", "create"]);
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    withTestDb(directory, (db) => db.run("ALTER TABLE task RENAME TO unavailable_task"));
    const broken = await run("activity", "list", "--task", "APP-1", "--json");
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stderr).error.code).not.toBe("not_found");
    expect(broken.stderr).not.toContain("--show-deleted");
  });
});

test("activity exact task IDs retain identity, status and original project deletion under limits", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      if (args.includes("--limit") && result.stderr.length > 0) {
        expect(result.stderr).toContain("--starting-after");
      } else {
        expect(result.stderr).toBe("");
      }
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Original task");
    await run("task", "edit", "APP-1", "--title", "Changed task");
    const firstHistory = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    const first = { id: firstHistory[0].entity_id as string };
    await run("project", "delete", "APP", "--yes");
    const deletion = JSON.parse(await run("activity", "list", "--json")).find((event: Activity) => event.entity_type === "project" && event.action === "delete");
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "New task");
    const secondHistory = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    const second = { id: secondHistory[0].entity_id as string };
    for (const [taskId, expected] of [[first.id, [deletion, ...firstHistory]], [second.id, secondHistory]] as const) {
      for (const spelling of [taskId, taskId.toUpperCase(), taskId.replaceAll("-", ""), taskId.replaceAll("-", "").toUpperCase()]) {
        expect(JSON.parse(await run("activity", "list", "--task-id", spelling, "--json"))).toEqual(expected);
      }
      expect(JSON.parse(await run("activity", "list", "--task-id", taskId, "--limit", "1", "--json"))).toEqual(expected.slice(0, 1));
    }
    const boundary = await run("activity", "list", "--task-id", first.id, "--limit", "1");
    expect(boundary).toContain("project APP");
    expect(boundary).toContain("deleted");
    expect(boundary).toContain("APP-1");
    expect(boundary).toContain(first.id);
    expect(boundary).not.toContain(second.id);
    const active = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(active).toContain(second.id);
    expect(active).toContain("current");
    await run("task", "archive", "APP-1");
    const archived = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(archived).toContain(second.id);
    expect(archived).toContain("[archived]");
    expect(await run("activity", "list", "--task", "APP-1")).not.toContain("[archived]");
    const archivedEvents = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    expect(archivedEvents.every((event: Activity) => event.entity_id === second.id)).toBe(true);
    expect(JSON.parse(await run("activity", "list", "--task-id", first.id, "--session", "missing", "--limit", "1", "--json"))).toEqual([]);
    await run("task", "delete", "APP-1", "--yes");
    const deleted = await run("activity", "list", "--task-id", second.id, "--limit", "1");
    expect(deleted).toContain(second.id);
    expect(deleted).toContain("deleted");
    expect(deleted).not.toContain(first.id);
  });
});

test("activity exact task IDs preserve empty histories and conjunctive session/thread filtering", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const taskId = "abcdef12-1234-7000-8000-123456abcdef";
    const events = await seedRecordedActivity(directory, [
      { id: "11111111-1111-7111-8111-111111111111", entity_id: taskId, created_at: 1, actor_session_id: "Session/one", actor_thread_id: "Thread/one", changes: { future: { text: "Full\ntext", values: [null, 2] } } },
      { id: "11111111-2111-7111-8111-111111111111", entity_id: taskId, created_at: 2, actor_session_id: "Session/one", actor_thread_id: "Thread/two" },
      { id: "11111111-3111-7111-8111-111111111111", entity_id: taskId, created_at: 1, actor_session_id: "Session/one", actor_thread_id: "Thread/one" },
      { id: "11111111-4111-7111-8111-111111111111", entity_id: "abcdef12-1234-7000-8000-123456abcdee", created_at: 3 },
    ]);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all());
    const query = (...flags: Array<string>) => runZinn(["activity", "list", "--task-id", taskId, ...flags, "--json"], directory);
    expect(JSON.parse((await query()).stdout)).toEqual([events[1], events[2], events[0]]);
    expect(JSON.parse((await query("--session", "Session/one", "--thread", "Thread/one", "--limit", "1")).stdout)).toEqual([events[2]]);
    expect(JSON.parse((await query("--session", "Session/one", "--thread", "Thread/one")).stdout)).toEqual([events[2], events[0]]);
    expect(JSON.parse((await query("--session", "session/one")).stdout)).toEqual([]);
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "No recorded history"], directory)).code).toBe(0);
    const emptyId = withTestDb(directory, (db) => {
      const id = db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
      db.query("DELETE FROM activity WHERE entity_type = 'task' AND entity_id = ?").run(id);
      return id;
    });
    for (const selector of [["--task", "APP-1"], ["--task-id", emptyId]]) {
      expect(await runZinn(["activity", "list", ...selector], directory)).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(JSON.parse((await runZinn(["activity", "list", ...selector, "--json"], directory)).stdout)).toEqual([]);
    }
  });
});

test("activity JSON preserves full matching records, parsed payloads and deterministic ordering", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const events = await seedRecordedActivity(directory, [
      { id: "11111111-1234-7000-8000-123456abcde1", created_at: 1, entity_type: "project", action: "create", changes: { key: "OLD", name: "Old project", columns: [] } },
      { id: "11111111-1234-7000-8000-123456abcde2", created_at: 2, entity_type: "column", action: "order", actor_name: null, actor_source: "adapter/test", actor_session_id: "session/1", actor_thread_id: "thread/2", actor_agent: "general", actor_model: "vendor/model", actor_effort: "medium" },
      { id: "11111111-1234-7000-8000-123456abcde3", created_at: 2, entity_type: "label", action: "delete", actor_email: null, changes: { name: "Old label", description: "Full\ntext", future: { values: [1, null] } } },
    ]);
    const listed = await runZinn(["activity", "list", "--json"], directory);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([events[2], events[1], events[0]]);
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", "1", "--json"], directory)).stdout)).toEqual([events[2]]);
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", String(Number.MAX_SAFE_INTEGER), "--json"], directory)).stdout)).toHaveLength(3);
    for (const event of events) {
      const viewed = await runZinn(["activity", "view", event.id, "--json"], directory);
      expect(viewed.code).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual(event);
    }
    const text = (await runZinn(["activity", "list"], directory)).stdout;
    expect(text).toContain("order");
    expect(text).toContain("column");
    expect(text).toContain("Entity ID: 11111111-1234-7000-8000-123456abcdef");
    const identityOf = (name: string) => text.split("\n").find((line) => line.includes(name))!.split(" · ")[0];
    expect(identityOf("project OLD")).toContain("deleted");
    expect(identityOf("label Old label")).toContain("deleted");
    expect(identityOf("column 1111")).toContain("deleted");
  });
});

test("project activity filters retain original member events and project lifetimes through the CLI", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: "project/run", ZINN_THREAD_ID: "project/thread" });
      expect(result.code, result.stderr).toBe(0);
      if (args.includes("--limit")) {
        expect(result.stderr).toContain("--starting-after");
      } else {
        expect(result.stderr).toBe("");
      }
      return result.stdout;
    };
    const list = async (...flags: Array<string>): Promise<Array<Activity>> => JSON.parse(await run("activity", "list", ...flags, "--json"));
    await run("project", "create", "APP");
    const firstProject = { id: (await list())[0]!.entity_id };
    await run("project", "create", "OUT");
    await run("project", "column", "create", "APP", "Extra");
    await run("task", "create", "APP", "--title", "Deleted before project");
    await run("task", "create", "APP", "--title", "Archived member");
    await run("task", "create", "OUT", "--title", "Outside");
    await run("task", "comment", "create", "APP-1", "--text", "Preserved note");
    await run("label", "create", "Attached");
    await run("task", "edit", "APP-1", "--add-label", "Attached");
    await run("label", "delete", "Attached", "--yes");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "create", "APP-1", "OUT-1", "--type", "related");
    await run("task", "archive", "APP-2");
    const memberIds = withTestDb(directory, (db) => new Set([
      firstProject.id,
      ...db.query<{ id: string }, [string]>("SELECT id FROM task WHERE project_id = ?").all(firstProject.id).map(row => row.id),
      ...db.query<{ id: string }, [string]>("SELECT id FROM project_column WHERE project_id = ?").all(firstProject.id).map(row => row.id),
    ]));
    await run("task", "delete", "APP-1", "--yes");
    const beforeDeletion = (await list()).filter(event => memberIds.has(event.entity_id));
    expect(await list("--project", "app")).toEqual(beforeDeletion);
    expect(beforeDeletion.filter(event => event.action === "relation_create")).toHaveLength(3);
    expect(beforeDeletion.some(event => event.entity_type === "label")).toBe(false);
    expect(beforeDeletion.some(event => event.action === "comment_create")).toBe(true);
    const text = await run("activity", "list", "--project", "APP");
    const displayedIds = text.split("\n").map(line => line.match(/^([0-9a-f-]{8,})\s/)?.[1]).filter(Boolean);
    expect(displayedIds).toHaveLength(beforeDeletion.length);
    expect(displayedIds.map(prefix => beforeDeletion.find(event => event.id.startsWith(prefix!))?.id))
      .toEqual(beforeDeletion.map(event => event.id));
    await run("project", "delete", "APP", "--yes");
    const firstLifetime = (await list()).filter(event => memberIds.has(event.entity_id));
    expect(await list("--project", "APP", "--show-deleted")).toEqual(firstLifetime);
    const aggregate = firstLifetime.find(event => event.entity_type === "project" && event.action === "delete")!;
    expect(aggregate.changes!.tasks).toHaveLength(1);
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "New lifetime");
    const current = await list("--task", "APP-1");
    expect((await list("--project", "APP")).filter(event => event.entity_type === "task")).toEqual(current);
    const all = await list("--project", "APP", "--show-deleted");
    expect(all).toEqual([...await list("--project", "APP"), ...firstLifetime]);
    for (const id of [firstProject.id, firstProject.id.toUpperCase(), firstProject.id.replaceAll("-", ""), firstProject.id.replaceAll("-", "").toUpperCase()]) {
      expect(await list("--project-id", id)).toEqual(firstLifetime);
    }
    expect(await list("--project", "APP", "--show-deleted", "--session", "project/run", "--thread", "project/thread", "--limit", "2")).toEqual(all.slice(0, 2));
    expect(await list("--project", "APP", "--session", "Project/run")).toEqual([]);
    const limited = await run("activity", "list", "--project", "APP", "--show-deleted", "--limit", "1");
    expect(limited).toContain(current[0]!.entity_id);
    const deletionText = await run("activity", "list", "--project-id", firstProject.id, "--limit", "1");
    expect(deletionText).toContain("APP");
    expect(deletionText).toContain((aggregate.changes!.tasks as Array<{ id: string }>)[0]!.id);
    const beforeReads = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const flags of [["--project", "UNKNOWN", "--show-deleted"], ["--project-id", "ffffffff-ffff-7fff-8fff-ffffffffffff"]]) {
      expect(await list(...flags)).toEqual([]);
      expect(await run("activity", "list", ...flags)).toBe("");
    }
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(beforeReads);
  });
});

test("project activity refuses missing current projects and invalid selectors without changing data", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const selector = routes.activity.list.input.constraints.find(constraint => constraint.kind === "exclusive")!;
    const values: Record<string, string> = { project: "APP", "project-id": id, task: "APP-1", "task-id": id };
    const invalid: Array<Array<string>> = [
      ["--project"], ["--project", ""], ["--project", "9APP"], ["--project", "APP-1"],
      ["--project", "APP", "--project", "OUT"], ["--project-id", id, "--project-id", id],
      ["--project-id"], ["--project-id", "abcdef12"], ["--project-id", id.slice(0, -1)],
      ["--project-id", "abcd-ef12123470008000123456abcdef"],
      ["--project-id", id, "--show-deleted"],
      ["--project", "APP", "--show-deleted", "--show-deleted"], ["--show-deleted"],
    ];
    const names = selector.members.map(member => member.slice("option:".length));
    for (const [index, left] of names.entries()) {
      for (const right of names.slice(index + 1)) {
        invalid.push([`--${left}`, values[left]!, `--${right}`, values[right]!]);
      }
    }
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());
    for (const flags of invalid) {
      const result = await runZinn(["activity", "list", ...flags, "--json"], directory);
      expect(result.code, flags.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
    const missing = await runZinn(["activity", "list", "--project", "gone", "--json"], directory);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(JSON.parse(missing.stderr).error).toMatchObject({ code: "not_found", details: { entity: "project", key: "GONE", argument: "--project" } });
    expect(JSON.parse(missing.stderr).error.help).toContain("--show-deleted");
    expect(JSON.parse(missing.stderr).error.help).toContain("gone");
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
    withTestDb(directory, db => db.run("ALTER TABLE project RENAME TO unavailable_project"));
    const broken = await runZinn(["activity", "list", "--project", "APP", "--json"], directory);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stderr).error.code).not.toBe("not_found");
    expect(broken.stderr).not.toContain("--show-deleted");
  });
});

test("limited project activity keeps deleted task and column names when identity snapshots are filtered out", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (args: Array<string>, session = "setup") => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: session });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run(["project", "create", "APP"]);
    const projectId = JSON.parse(await run(["activity", "list", "--json"]))[0].entity_id;
    await run(["project", "column", "create", "APP", "Extra"]);
    await run(["task", "create", "APP", "--title", "Original"]);
    const taskId = JSON.parse(await run(["activity", "list", "--task", "APP-1", "--json"]))[0].entity_id;
    await run(["task", "edit", "APP-1", "--title", "Edited"], "task/edit");
    await run(["project", "edit", "APP", "--name", "Renamed"], "project/edit");
    await run(["project", "column", "edit", "APP", "Extra", "--name", "Renamed column"], "column/edit");
    await run(["task", "delete", "APP-1", "--yes"]);
    await run(["project", "delete", "APP", "--yes"]);
    await run(["project", "create", "APP"]);
    await run(["task", "create", "APP", "--title", "Reused key"]);
    const flags = ["activity", "list", "--project-id", projectId, "--limit", "1", "--session"];
    const taskText = await run([...flags, "task/edit"]);
    expect(taskText).toContain("APP-1");
    expect(taskText).toContain(taskId);
    expect(taskText).toContain("deleted");
    const taskEvents = JSON.parse(await run([...flags, "task/edit", "--json"]));
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toMatchObject({ entity_id: taskId, action: "edit", changes: { title: ["Original", "Edited"] } });
    expect(await run([...flags, "project/edit"])).toContain("project APP [deleted]");
    expect(await run([...flags, "column/edit"])).toContain("column Renamed column [deleted]");
    const help = await run(["activity", "list", "--help"]);
    for (const flag of ["--project", "--project-id", "--task", "--task-id", "--show-deleted"]) {
      expect(help).toContain(flag);
    }
  });
});

test("project activity navigation scans history a bounded number of times for many deleted tasks", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const result = await runProcessAsync([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { spyOn } from "bun:test";
      import { activity, project, task } from ${JSON.stringify(join(import.meta.dir, "../../core/index.ts"))};
      import * as dbActivity from ${JSON.stringify(join(import.meta.dir, "../../core/src/db/activity.ts"))};
      import { presentActivities } from ${JSON.stringify(join(import.meta.dir, "../src/presentation/activity-presentation.ts"))};
      const actor = { name: "Test", email: null, kind: "human" };
      const app = project.create({ key: "APP" }, actor);
      const first = task.create({ project_id: app.id, title: "First" }, actor);
      task.edit({ taskKey: first.key, title: "Edited" }, { ...actor, sessionId: "selected" });
      task.delete(first.key, actor);
      for (let index = 0; index < 100; index++) {
        const item = task.create({ project_id: app.id, title: "Deleted " + index }, actor);
        task.delete(item.key, actor);
      }
      const retained = task.create({ project_id: app.id, title: "Retained until project deletion" }, actor);
      project.delete("APP", actor);
      const currentProject = project.create({ key: "APP" }, actor);
      const current = task.create({ project_id: currentProject.id, title: "Reused key" }, actor);
      task.archive(current.key, actor);
      const selected = activity.getAll({ projectId: app.id, sessionId: "selected", limit: 1 }).events;
      const deletion = activity.getAll({ projectId: app.id, limit: 1 }).events;
      const globalHistory = spyOn(dbActivity, "getAll");
      const deletionHistory = spyOn(dbActivity, "getTaskDeletionEvents");
      const maxFullHistoryScans = 2;
      const checkScans = () => {
        assert.ok(globalHistory.mock.calls.length <= maxFullHistoryScans);
        assert.ok(deletionHistory.mock.calls.length <= 1,
          "Deletion history must not be reread for each historical task key");
        globalHistory.mockClear();
        deletionHistory.mockClear();
      };
      const [historical] = presentActivities(selected, { projectId: app.id });
      assert.equal(historical.navigation.name, first.key);
      assert.equal(historical.navigation.status, "deleted");
      assert.equal(historical.navigation.distinguishesTaskId, true);
      checkScans();
      const [aggregate] = presentActivities(deletion, { projectId: app.id });
      assert.deepEqual(aggregate.removedTasks, [{ id: retained.id, key: retained.key,
        title: retained.title, status: "deleted" }]);
      checkScans();
      const currentEvents = activity.getAll({ projectKey: "APP", limit: 1 }).events;
      globalHistory.mockClear();
      const [archived] = presentActivities(currentEvents, { projectKey: "APP" });
      assert.equal(archived.navigation.name, current.key);
      assert.equal(archived.navigation.status, "archived");
      checkScans();
    `], { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory } });
    expect(result.code, result.stderr).toBe(0);
  });
});

test("activity returns all events by default and limits only after selecting matches", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const events = await seedRecordedActivity(directory, Array.from({ length: 55 }, (_, index) => ({
      id: `11111111-1234-7000-8000-${String(index).padStart(12, "0")}`,
      created_at: index,
    })));
    expect(JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout)).toEqual(events.toReversed());
    expect(JSON.parse((await runZinn(["activity", "list", "--limit", "2", "--json"], directory)).stdout)).toEqual(events.toReversed().slice(0, 2));
  });
});

test("activity continuation commands preserve filters, globals and shell-sensitive values", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const session = "-a session ' $(touch pagination-injected) `touch pagination-injected`\nnext";
    const thread = "thread with spaces";
    const records = await seedRecordedActivity(directory, Array.from({ length: 7 }, (_, index) => ({
      id: `22222222-1234-7000-8000-${String(index).padStart(12, "0")}`,
      created_at: index, actor_session_id: session, actor_thread_id: thread,
      action: index % 2 === 0 ? "edit" as const : "comment_create" as const,
      changes: { priority: [null, "high"], title: ["before", "after"] },
    })));
    const expected = records.filter((event) => event.action === "edit").toReversed();
    const args = ["activity", "list", `--session=${session}`, "--thread", thread,
      "--since", "0", "--until", "6", "--action", "edit", "--action", "comment_create",
      "--changed", "priority=HIGH", "--changed", "priority=low", "--changed", "title",
      "--limit", "1", "--json", "--allow-legacy-read"];
    let result = await runZinn(args, directory);
    for (let index = 0; index < expected.length; index++) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expected[index]!]);
      if (index === expected.length - 1) {
        expect(result.stderr).toBe("");
        break;
      }
      const commandStart = result.stderr.indexOf("zinn ");
      expect(commandStart).toBeGreaterThanOrEqual(0);
      const command = result.stderr.slice(commandStart).trimEnd();
      expect(command).toContain(expected[index]!.id);
      expect(command).toContain("--json");
      expect(command).toContain("--allow-legacy-read");
      expect(command.match(/--starting-after/g)).toHaveLength(1);
      result = await runProcessAsync(["/bin/sh", "-c",
        'zinn() { bun "$ZINN_TEST_CLI" "$@"; }\n' + command],
        { cwd: directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, ZINN_TEST_CLI: CLI_PATH } });
      expect(existsSync(join(directory, "pagination-injected"))).toBe(false);
    }
    const text = await runZinn(args.filter((arg) => arg !== "--json"), directory);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("edit");
    expect(text.stderr).toContain("--starting-after");
    expect(text.stderr).not.toContain("--json");
    const uncapped = await runZinn(["activity", "list", "--starting-after", expected[0]!.id, "--json"], directory);
    expect(uncapped.code).toBe(0);
    expect(uncapped.stderr).toBe("");
    expect(JSON.parse(uncapped.stdout)).toEqual(records.toReversed().slice(1));
  });
});

test("activity continuation shares lookup errors and accepts compact and prefix IDs outside selection", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const records = await seedRecordedActivity(directory, [
      { id: "abcdef12-1234-7000-8000-123456abcde1", created_at: 10 },
      { id: "abcdef12-2234-7000-8000-123456abcde2", created_at: 20 },
      { id: "abcdef13-1234-7000-8000-123456abcde3", created_at: 30 },
    ]);
    for (const id of [records[1]!.id.toUpperCase().replaceAll("-", ""), "abcdef12-2"]) {
      const result = await runZinn(["activity", "list", "--starting-after", id, "--until", "10", "--json"], directory);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([records[0]!]);
      expect(result.stderr).toBe("");
    }
    for (const id of ["abcdef", "abcdef12", "ffffffff", "bad-id"]) {
      const view = await runZinn(["activity", "view", id, "--json"], directory);
      const page = await runZinn(["activity", "list", "--starting-after", id, "--json"], directory);
      expect(page.code).toBe(1);
      expect(page.stdout).toBe("");
      const pageError = JSON.parse(page.stderr).error;
      const viewError = JSON.parse(view.stderr).error;
      expect(pageError.code).toBe(viewError.code);
      expect(pageError.message).toBe(viewError.message);
      if (pageError.code === "invalid_input") {
        expect(pageError.details.field).toEqual(["startingAfter"]);
      } else {
        expect(pageError.details).toEqual(viewError.details);
      }
    }
    for (const ending of [records[0]!.id, records[1]!.id]) {
      const result = await runZinn(["activity", "list", "--starting-after", ending, "--limit", "1", "--json"], directory);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
    for (const args of [
      ["--starting-after"],
      ["--starting-after="],
      ["--starting-after", records[0]!.id, "--starting-after", records[1]!.id],
    ]) {
      const result = await runZinn(["activity", "list", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
  });
});

test("activity task-filtered prefixes remain globally unique even outside the filter and limit", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Current task"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const first = "abcdef12-1234-7000-8000-000000000001";
    const second = "abcdef12-1234-7000-8000-000000000002";
    await seedRecordedActivity(directory, [
      { id: first, created_at: Date.now() + 1000, entity_id: taskId },
      { id: second, created_at: Date.now() + 2000, entity_type: "label" },
    ]);
    const filtered = await runZinn(["activity", "list", "--task", "app-1", "--limit", "1"], directory);
    expect(filtered.code).toBe(0);
    expect(filtered.stdout.split(" | ")[0]).toBe(first);
    expect(filtered.stdout).toContain("APP-1 · edited");
    expect(filtered.stdout).not.toContain("[current]");
    expect(filtered.stdout).not.toContain(second);
    const ambiguous = await runZinn(["activity", "view", "abcdef12", "--json"], directory);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stdout).toBe("");
    const failure = errorDocumentSchema.parse(JSON.parse(ambiguous.stderr)).error;
    expect(failure).toMatchObject({ code: "conflict", details: { reason: "ambiguous_reference", matchCount: 2, candidateIds: expect.arrayContaining([first, second]) } });
    expect(failure.message).toContain(first);
    expect(failure.message).toContain(second);
  });
});

test("activity view accepts normalized IDs and reports malformed, short and missing IDs distinctly", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = await seedRecordedActivity(directory, [{ id }]);
    for (const input of [id, id.toUpperCase(), id.replaceAll("-", ""), "ABCDEF12", "ABCDEF12-1", "ABCDEF121"]) {
      const result = await runZinn(["activity", "view", input, "--json"], directory);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(event);
    }
    for (const [input, expected] of [
      ["abcdef1", { code: "invalid_input", details: { field: [] } }],
      ["abcd-ef12", { code: "invalid_input", details: { field: [] } }],
      ["ffffffff", { code: "not_found", details: { entity: "activity", key: "ffffffff" } }],
    ] as const) {
      const result = await runZinn(["activity", "view", input, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
  });
});

test("activity rejects unsupported, repeated and malformed command arguments without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const [event] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef" }]);
    const before = withTestDb(directory, (db) => db.query("SELECT * FROM activity").all());
    const invalid = [
      ["list", "APP-1"], ["list", "--project", "APP-1"],
      ["list", "--task", "APP-1", "--task", "APP-2"],
      ["list", "--limit", "1", "--limit", "2"], ["list", "--task", "APP-0"],
      ["list", "--session", "first", "--session", "second"],
      ["list", "--thread", "first", "--thread", "second"],
      ["list", "--task-id", event!.entity_id, "--task-id", event!.entity_id],
      ["list", "--task", "APP-1", "--show-deleted", "--show-deleted"],
      ["list", "--task", "APP-1", "--task-id", event!.entity_id],
      ["list", "--show-deleted"], ["list", "--task-id", event!.entity_id, "--show-deleted"],
      ["list", "--task-id"], ["list", "--task-id", ""],
      ["list", "--task-id", "abcdef12"], ["list", "--task-id", event!.id.slice(0, -1)],
      ["list", "--task-id", "abcd-ef12123470008000123456abcdef"],
      ["list", "--task", "APP-1", "--show-deleted=true"],
      ["list", "--session", ""], ["list", "--thread", ""],
      ["view"], ["view", event!.id, "extra"], ["view", event!.id, "--task", "APP-1"],
      ["view", event!.id, "--session", "session"],
    ];
    for (const args of invalid) {
      const result = await runZinn(["activity", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.message.length).toBeGreaterThan(0);
    }
    for (const [limit, details] of [
      ...["0", "-1", "1.5", "1e2", "01", " 2", "Infinity", "99999999999999999"]
        .map((limit) => [limit, { argument: "--limit" }] as const),
      ["9007199254740992", { field: ["limit"] }],
    ] as const) {
      const result = await runZinn(["activity", "list", `--limit=${limit}`, "--json"], directory);
      expect(result.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "invalid_input", details });
    }
    expect(withTestDb(directory, (db) => db.query("SELECT * FROM activity").all())).toEqual(before);
  });
});

test("session activity filters return only committed changes and compose with thread, task and limit", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (args: Array<string>, env: Record<string, string> = {}) => runZinnAs(args, directory, env);
    const events = async (...flags: Array<string>): Promise<Array<Activity>> => {
      const result = await run(["activity", "list", ...flags, "--json"]);
      expect(result.code).toBe(0);
      if (flags.includes("--limit")) {
        expect(result.stderr).toContain("--starting-after");
      } else {
        expect(result.stderr).toBe("");
      }
      return JSON.parse(result.stdout);
    };
    const first = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "Conversation/A" };
    const second = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "Conversation/B" };
    const child = {
      CODEX_SESSION_ID: "Conversation/C", CODEX_THREAD_ID: "Child/1",
      ZINN_AGENT: "worker", ZINN_MODEL: "vendor/model", ZINN_EFFORT: "low",
    };
    const parent = { CODEX_SESSION_ID: "Conversation/C", CODEX_THREAD_ID: "Conversation/C" };
    expect((await run(["project", "create", "RUN"], first)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "First"], first)).code).toBe(0);
    expect((await run(["task", "edit", "RUN-1", "--title", "Changed"], first)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "Second"], second)).code).toBe(0);
    expect((await run(["task", "create", "RUN", "--title", "Child"], child)).code).toBe(0);
    expect((await run(["task", "edit", "RUN-2", "--title", "Parent update"], parent)).code).toBe(0);

    const session = await events("--session", "Conversation/A");
    expect(session.map((event) => [event.entity_type, event.action])).toEqual([
      ["task", "edit"], ["task", "create"], ["project", "create"],
    ]);
    expect(session.every((event) => event.actor_session_id === "Conversation/A" && event.actor_thread_id === null)).toBe(true);
    expect(await events("--session", "Conversation/A", "--task", "run-1", "--limit", "1")).toEqual([session[0]!]);
    const childEvents = await events("--thread", "Child/1");
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]).toMatchObject({ actor_session_id: "Conversation/C", actor_thread_id: "Child/1", changes: { title: "Child" } });
    expect(await events("--session", "Conversation/C", "--thread", "Child/1")).toEqual(childEvents);
    expect(await events("--session", "Conversation/C")).toHaveLength(2);
    expect(await events("--thread", "Conversation/C")).toHaveLength(1);

    const historicalId = "abcdef12-1234-7000-8000-123456abcde1";
    await seedRecordedActivity(directory, [{ id: historicalId, actor_name: "1", entity_id: session[0]!.entity_id }]);
    expect((await events()).some((event) => event.id === historicalId)).toBe(true);
    expect(await events("--session", "Conversation/A")).toEqual(session);
    const before = await events();
    expect((await run(["task", "edit", "RUN-1", "--title", "Changed"], first)).code).toBe(0);
    expect((await run(["task", "move", "RUN-1", "Missing"], first)).code).toBe(1);
    expect(await events()).toEqual(before);

    for (const flags of [
      ["--session", "conversation/A"], ["--session", "Conversation"],
      ["--session", " Conversation/A"], ["--thread", "Child"],
      ["--session", "Conversation/A", "--thread", "Child/1"],
    ]) {
      expect(await events(...flags)).toEqual([]);
      expect(await run(["activity", "list", ...flags])).toEqual({ code: 0, stdout: "", stderr: "" });
    }

    const view = await run(["activity", "view", childEvents[0]!.id]);
    expect(view.code).toBe(0);
    for (const detail of ["Source: env:CODEX_THREAD_ID", "Session: Conversation/C", "Thread: Child/1", "Agent: worker", "Model: vendor/model", "Effort: low"]) {
      expect(view.stdout).toContain(detail);
    }
    const historical = await run(["activity", "view", historicalId]);
    expect(historical.code).toBe(0);
    for (const field of ["Source", "Session", "Thread", "Agent", "Model", "Effort"]) {
      expect(historical.stdout).toContain(`${field}: null`);
    }
  });
});

test("activity recovers deleted and reused task lifetimes, retaining the original project deletion", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Old lifetime")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Unrelated")).code).toBe(0);
    const oldTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    expect((await run("task", "archive", "APP-1")).code).toBe(0);
    const archivedEvents: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "APP-1", "--json")).stdout);
    const archiveEvent = archivedEvents.find((event) => event.action === "archive")!;
    expect((await run("activity", "list", "--task", "APP-1")).stdout).not.toContain("[archived]");
    expect((await run("activity", "view", archiveEvent.id)).stdout).toContain("[archived]");
    expect((await run("project", "delete", "APP", "--yes")).code).toBe(0);
    const deletion = JSON.parse((await run("activity", "list", "--json")).stdout).find((event: Activity) => event.entity_type === "project" && event.action === "delete");
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "New lifetime")).code).toBe(0);
    const newTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id);
    const current = JSON.parse((await run("activity", "list", "--task", "APP-1", "--json")).stdout);
    expect(current).toHaveLength(1);
    expect(current[0].entity_id).toBe(newTaskId);
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "app-1", "--show-deleted", "--json")).stdout);
    expect(events).toHaveLength(4);
    expect(events.find((event) => event.id === deletion.id)).toEqual(deletion);
    expect(new Set(events.filter((event) => event.entity_type === "task").map((event) => event.entity_id))).toEqual(new Set([oldTaskId, newTaskId]));
    const text = (await run("activity", "list", "--task", "APP-1", "--show-deleted")).stdout;
    const projectDeletionRow = text.split("\n").find((line) => line.includes("project APP"))!;
    expect(projectDeletionRow.split(" · ")[0]).toContain("deleted");
    expect(text).toContain(newTaskId);
    expect(text).toContain(`removed APP-1 (${oldTaskId})`);
    const limited = (await run("activity", "list", "--task", "APP-1", "--show-deleted", "--limit", "1")).stdout;
    expect(limited.split("\n")[0]!.split(" · ")[0]).not.toContain("deleted");
    expect(limited).toContain(newTaskId);
    expect(limited).not.toContain(oldTaskId);
    expect(JSON.parse((await run("activity", "list", "--task", "APP-99", "--show-deleted", "--json")).stdout)).toEqual([]);
    const viewedDeletion = (await run("activity", "view", deletion.id)).stdout;
    expect(viewedDeletion).toContain(oldTaskId);
    expect(viewedDeletion.split("\n")[0]).toContain("deleted");
  });
});

test("activity marks deleted lifetimes of a reused key and keeps every task ID", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    const taskIds: Array<string> = [];
    for (const title of ["First lifetime", "Second lifetime", "Third lifetime"]) {
      if (taskIds.length > 0) {
        expect((await run("project", "delete", "APP", "--yes")).code).toBe(0);
      }
      expect((await run("project", "create", "APP")).code).toBe(0);
      expect((await run("task", "create", "APP", "--title", title)).code).toBe(0);
      taskIds.push(withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task WHERE number = 1").get()!.id));
    }
    expect((await run("task", "archive", "APP-1")).code).toBe(0);
    const [firstId, secondId, archivedId] = taskIds as [string, string, string];
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json")).stdout);
    expect(new Set(events.filter((event) => event.entity_type === "task").map((event) => event.entity_id))).toEqual(new Set(taskIds));

    // A task row's ID line follows the row; project rows list removed tasks instead.
    const lines = (await run("activity", "list", "--task", "APP-1", "--show-deleted")).stdout.split("\n");
    const taskRowIds = (isDeleted: boolean) =>
      new Set(lines.flatMap((line, index) => {
        const identity = line.split(" · ")[0]!;
        const isTaskRow = identity.includes("APP-1") && !identity.includes("project APP");
        return isTaskRow && identity.includes("deleted") === isDeleted
          ? taskIds.filter((id) => lines[index + 1]?.includes(id))
          : [];
      }));
    expect(taskRowIds(true)).toEqual(new Set([firstId, secondId]));
    expect(taskRowIds(false)).toEqual(new Set([archivedId]));
  });
});

test("activity finds explicit task deletions and deletion-only historical snapshots", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Delete me"], directory)).code).toBe(0);
    expect((await runZinn(["task", "delete", "APP-1", "--yes"], directory)).code).toBe(0);
    const explicit = await runZinn(["activity", "list", "--task", "APP-1", "--show-deleted"], directory);
    expect(explicit.code).toBe(0);
    const explicitRows = explicit.stdout.trimEnd().split("\n");
    expect(explicitRows).toHaveLength(2);
    expect(explicitRows.every((row) => row.split(" · ")[0]!.includes("deleted"))).toBe(true);
    expect(explicit.stdout).toContain("Delete me");
    const [snapshot] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", entity_type: "project", action: "delete",
      changes: { key: "GONE", tasks: [{ id: "old-task", key: "GONE-2", title: "Snapshot only" }] } }]);
    expect(JSON.parse((await runZinn(["activity", "list", "--task", "gone-2", "--show-deleted", "--json"], directory)).stdout)).toEqual([snapshot]);
    expect((await runZinn(["activity", "list", "--task", "GONE-2", "--show-deleted"], directory)).stdout).toContain("removed GONE-2 (old-task)");
  });
});

test("activity retains each relation event and uses current names only for navigation", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = (...args: Array<string>) => runZinn(args, directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "First")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "Second")).code).toBe(0);
    expect((await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related")).code).toBe(0);
    expect((await run("label", "create", "Before")).code).toBe(0);
    expect((await run("label", "edit", "Before", "--name", "Now")).code).toBe(0);
    const events: Array<Activity> = JSON.parse((await run("activity", "list", "--json")).stdout);
    const relations = events.filter((event) => event.action === "relation_create");
    expect(relations).toHaveLength(2);
    expect(relations[0]!.id).not.toBe(relations[1]!.id);
    expect(relations[0]!.changes).toEqual(relations[1]!.changes);
    const text = (await run("activity", "list")).stdout;
    expect(text.match(/added relation/g)).toHaveLength(2);
    expect(text).toContain("source: APP-1");
    expect(text).toContain("target: APP-2");
    const labelCreate = events.find((event) => event.entity_type === "label" && event.action === "create")!;
    const view = (await run("activity", "view", labelCreate.id)).stdout;
    expect(view).toContain("label Now [current]");
    expect(view).toContain("name:\nBefore");
    expect(JSON.parse((await run("activity", "view", labelCreate.id, "--json")).stdout)).toEqual(labelCreate);
  });
});

test("activity views preserve recorded text, actor/entity identity, unknown fields and local offsets", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const oldText = "  Before\n\tSecond line\n";
    const newText = "  After\r\n\tFinal line  ";
    const id = "abcdef12-1234-7000-8000-123456abcdef";
    const [event] = await seedRecordedActivity(directory, [{ id,
      changes: { title: ["Old title", "New title"], description: [oldText, newText], future: { text: "Unknown\ntext", values: [null, 2] } } }]);
    const view = await runZinn(["activity", "view", "abcdef12"], directory, { TZ: "Europe/Berlin" });
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(id);
    expect(view.stdout).toContain(event!.entity_id);
    expect(view.stdout).toContain("Test Agent");
    expect(view.stdout).toContain("agent@example.com");
    expect(view.stdout).toContain("Kind: agent");
    expect(view.stdout).toContain("2026-10-08 12:30 +02:00");
    expect(view.stdout).toContain(oldText);
    expect(view.stdout).toContain(newText);
    expect(view.stdout).toContain("Raw JSON:");
    expect(view.stdout).toContain('"future"');
    expect(view.stdout).toContain('"Unknown\\ntext"');
    const listed = (await runZinn(["activity", "list"], directory)).stdout;
    expect(listed).toContain("description changed");
    expect(listed).not.toContain(oldText);
    expect(JSON.parse((await runZinn(["activity", "view", id, "--json"], directory)).stdout)).toEqual(event);
    const [commentEvent] = await seedRecordedActivity(directory, [{ id: "fedcba98-1234-7000-8000-123456abcdef", action: "comment_create",
      changes: { comment: { id: "old-comment", key: "APP-1#1", text: oldText } } }]);
    expect((await runZinn(["activity", "view", commentEvent!.id], directory)).stdout).toContain(oldText);
  });
});

test.each([0, 9])("activity commands read schema version %i under the existing policy without writes", async (version) => {
  await withIsolatedZinnDir(async (directory) => {
    const [event] = await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-123456abcdef", action: "delete",
      changes: { key: "GONE-1", title: "Deleted" } }]);
    withTestDb(directory, (db) => db.run(`PRAGMA user_version = ${version}`));
    const snapshot = () => withTestDb(directory, (db) => ({
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
      events: db.query("SELECT * FROM activity").all(),
      version: db.query("PRAGMA user_version").get(),
    }));
    const before = snapshot();
    if (version === 0) {
      const refused = await runZinn(["activity", "list", "--json"], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr).error.message).toContain("--allow-legacy-read");
    }
    const flags = version === 0 ? ["--allow-legacy-read"] : [];
    for (const args of [["list"], ["list", "--project", "GONE", "--show-deleted"], ["list", "--project-id", event!.entity_id], ["list", "--task", "GONE-1", "--show-deleted"], ["list", "--task-id", event!.entity_id], ["view", event!.id]]) {
      for (const mode of [[], ["--json"]]) {
        const result = await runZinn(["activity", ...args, ...flags, ...mode], directory);
        expect(result.code).toBe(0);
        if (version === 0) {
          expect(result.stderr.match(/Warning:/g)).toHaveLength(1);
        } else {
          expect(result.stderr).toBe("");
        }
      }
    }
    expect(snapshot()).toEqual(before);
  });
});
