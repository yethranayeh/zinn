import { expect, test } from "bun:test";
import type { Activity } from "@zinn-dev/core";
import { runZinn, seedRecordedActivity, taskViewContent, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task view history opts into shared activity previews and full JSON without writes", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Inspected task");
    await run("task", "create", "APP", "--title", "Other task");
    await run("task", "edit", "APP-1", "--description", "Full\nrecorded description");
    await run("task", "order", "APP-1", "bottom");
    await run("task", "move", "APP-1", "In Progress");
    const originalComment = "Original comment text\n" + "Previous content. ".repeat(20);
    await run("task", "comment", "create", "APP-1", "--text", originalComment);
    await run("task", "comment", "edit", "APP-1#1", "--text", "Current comment");
    await run("task", "comment", "create", "APP-1", "--text", "Deleted comment");
    await run("task", "comment", "delete", "APP-1#2", "--yes");
    await run("task", "relation", "create", "APP-1", "APP-2", "--type", "related");
    await run("task", "relation", "delete", "APP-1", "APP-2", "--type", "related");
    await run("task", "archive", "APP-1");
    await run("task", "unarchive", "APP-1");

    const events: Array<Activity> = JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"));
    expect(events.find((event) => event.action === "order")).toBeDefined();
    expect(events.find((event) => event.action === "comment_delete")?.changes?.comment).toMatchObject({
      key: "APP-1#2", text: "Deleted comment",
    });
    expect(events.find((event) => event.action === "comment_edit")?.changes?.text).toEqual([
      originalComment, "Current comment",
    ]);

    const ordinaryText = await run("task", "view", "APP-1");
    const ordinaryJson = JSON.parse(await run("task", "view", "APP-1", "--json"));
    expect(ordinaryJson).not.toHaveProperty("activity");
    const historyJson = JSON.parse(await run("task", "view", "app-1", "--history", "--json"));
    expect(historyJson).toEqual({ ...ordinaryJson, activity: events });
    expect(historyJson.comments).toHaveLength(1);
    expect(historyJson.comments[0].text).toBe("Current comment");
    expect(historyJson.comments[0]).not.toHaveProperty("activity");

    const previews = await run("activity", "list", "--task", "APP-1");
    const historyText = await run("task", "view", "APP-1", "--history");
    expect(taskViewContent(historyText).startsWith(taskViewContent(ordinaryText).trimEnd())).toBe(true);
    expect(taskViewContent(historyText).endsWith(previews)).toBe(true);
    expect(historyText).not.toContain(originalComment);
    const commentEdit = events.find((event) => event.action === "comment_edit")!;
    expect(await run("activity", "view", commentEdit.id)).toContain(originalComment);
    expect(JSON.parse(await run("activity", "list", "--task", "APP-1", "--json"))).toEqual(events);
    expect(JSON.parse(await run("task", "view", "APP-1", "--json"))).toEqual(ordinaryJson);
  });
});

test("task view only reads history when requested and includes an empty activity array", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Before recording"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const ordinary = await runZinn(["task", "view", "APP-1", "--json"], directory);
    expect(ordinary.code).toBe(0);
    const requested = await runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(requested.code).toBe(0);
    expect(JSON.parse(requested.stdout)).toEqual({ ...JSON.parse(ordinary.stdout), activity: [] });
    expect(await runZinn(["task", "view", "APP-1", "--history"], directory)).toEqual(
      await runZinn(["task", "view", "APP-1"], directory),
    );

    await seedRecordedActivity(directory, [{ id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId }]);
    withTestDb(directory, (db) => db.run("UPDATE activity SET changes = 'invalid JSON'"));
    expect(await runZinn(["task", "view", "APP-1", "--json"], directory)).toEqual(ordinary);
    expect((await runZinn(["task", "view", "APP-1"], directory)).code).toBe(0);
    expect((await runZinn(["task", "view", "APP-1", "--history", "--json"], directory)).code).toBe(1);
  });
});

test("task view history orders timestamp ties and preserves full records for only its task", async () => {
  await withIsolatedZinnDir(async (directory) => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Current task"], directory)).code).toBe(0);
    const taskId = withTestDb(directory, (db) => {
      db.run("DELETE FROM activity");
      return db.query<{ id: string }, []>("SELECT id FROM task").get()!.id;
    });
    const events = await seedRecordedActivity(directory, [
      { id: "abcdef12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 3, changes: { title: ["Old title", "Current task"], future: { text: "Full\nrecorded payload" } } },
      { id: "fedcba12-1234-7000-8000-000000000001", entity_id: taskId, created_at: 1, action: "order" },
      { id: "abcdef12-1234-7000-8000-000000000002", entity_id: taskId, created_at: 3, action: "archive", actor_email: null },
      { id: "abcdef12-1234-7000-8000-000000000003", entity_id: taskId, entity_type: "label", created_at: 4 },
    ]);
    const viewed = await runZinn(["task", "view", "APP-1", "--history", "--json"], directory);
    expect(viewed.code).toBe(0);
    expect(JSON.parse(viewed.stdout).activity).toEqual([events[2], events[0], events[1]]);
    const previews = await runZinn(["activity", "list", "--task", "APP-1"], directory);
    const text = await runZinn(["task", "view", "APP-1", "--history"], directory);
    expect(text.code).toBe(0);
    expect(taskViewContent(text.stdout).endsWith(previews.stdout)).toBe(true);
    expect(text.stdout).toContain("Old title");
  });
});

test("task view history keeps archived tasks separate from deleted lifetimes with a reused key", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code).toBe(0);
      return result.stdout;
    };
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Previous lifetime");
    await run("project", "delete", "APP", "--yes");
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Current lifetime");
    await run("task", "archive", "APP-1");
    const currentTaskId = withTestDb(directory, (db) => db.query<{ id: string }, []>("SELECT id FROM task").get()!.id);
    const allLifetimes: Array<Activity> = JSON.parse(await run("activity", "list", "--task", "APP-1", "--show-deleted", "--json"));
    expect(allLifetimes.some((event) => event.entity_id !== currentTaskId)).toBe(true);
    const viewed = JSON.parse(await run("task", "view", "APP-1", "--history", "--json"));
    expect(viewed.status).toBe("Archived");
    expect(viewed.activity).toEqual(allLifetimes.filter((event) => event.entity_type === "task" && event.entity_id === currentTaskId));
    const text = await run("task", "view", "APP-1", "--history");
    expect(text).not.toContain(currentTaskId);
    expect(text).not.toContain("Previous lifetime");
  });
});

