import { expect, test } from "bun:test";
import { taskAttributionSchema, resultSchemas } from "../src/result-schemas";
import { formatLocalTime } from "../src/presentation/time";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

const first = { AI_AGENT: "first-worker@1", ZINN_SESSION_ID: "first-session", ZINN_THREAD_ID: "first-thread",
  ZINN_AGENT: "first-agent", ZINN_MODEL: "first-model", ZINN_EFFORT: "high", ZINN_CLIENT: "adapter/1" };
const second = { AI_AGENT: "second-worker", ZINN_SESSION_ID: "second-session", ZINN_THREAD_ID: "second-thread",
  ZINN_AGENT: "second-agent", ZINN_MODEL: "second-model", ZINN_EFFORT: "low", ZINN_CLIENT: "adapter/2" };

test("task blame exposes fields, line provenance, full identity and the read-only JSON capability contract", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (args: Array<string>, environment = first) => {
      const result = await runZinn(args, directory, environment);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run(["project", "create", "APP"]);
    await run(["label", "create", "chosen"]);
    await run(["task", "create", "APP", "--title", "Blamed task", "--description", "first\n\n last \n", "--label", "chosen"]);
    await run(["task", "create", "APP", "--title", "Parent"]);
    await run(["task", "edit", "APP-1", "--description", "first\ninserted\n\n last \n", "--priority", "high", "--due", "2026-11-05T08:00:12.123Z"], second);
    await run(["task", "relation", "create", "APP-1", "APP-2", "--type", "subtask"], second);
    await run(["task", "archive", "APP-1"]);
    const snapshot = () => withTestDb(directory, db => ({
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      relations: db.query("SELECT * FROM task_relations ORDER BY id").all(),
      labels: db.query("SELECT * FROM task_label ORDER BY task_id, label_id").all(),
    }));
    const before = snapshot();
    const result = resultSchemas.TaskBlame.parse(JSON.parse(await run(["task", "blame", "APP-1", "--json"])));
    expect(result.task.key).toBe("APP-1");
    expect(Object.keys(result.fields)).toEqual(["title", "column", "priority", "due_at", "labels", "parent"]);
    expect(result.fields.title).toMatchObject({ value: "Blamed task", attribution: { actor_name: first.AI_AGENT, actor_session_id: first.ZINN_SESSION_ID } });
    expect(result.fields.priority).toMatchObject({ value: "high", attribution: { actor_name: second.AI_AGENT, actor_session_id: second.ZINN_SESSION_ID } });
    expect(result.fields.due_at.value).toBe(Date.parse("2026-11-05T08:00:12.123Z"));
    expect(result.fields.parent.value?.key).toBe("APP-2");
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({ type: "subtask", direction: "outgoing", task: { key: "APP-2" } });
    expect(result.description.map(line => [line.line, line.text, line.attribution?.actor_session_id]))
      .toEqual([[1, "first", "first-session"], [2, "inserted", "second-session"], [3, "", "first-session"], [4, " last ", "first-session"]]);
    const attribution = result.fields.priority.attribution!;
    expect(Object.keys(attribution).sort()).toEqual(Object.keys(taskAttributionSchema.shape).sort());
    expect(attribution).not.toHaveProperty("changes");
    const text = await run(["task", "blame", "APP-1"]);
    for (const fact of ["Blamed task", "chosen", "APP-2", "first", "inserted", " last ", "agent",
      ...Object.values(attribution).filter((value): value is string => typeof value === "string"),
      formatLocalTime(attribution.created_at, { includesSeconds: true }), formatLocalTime(result.fields.due_at.value!, { includesSeconds: true }),
    ]) {
      expect(text).toContain(fact);
    }
    const capabilities = JSON.parse(await run(["capabilities", "--json"]));
    const command = capabilities.commands.find((entry: { path: string[] }) => entry.path.join(" ") === "task blame");
    expect(command.effects).toEqual({ domain: "read", storage: "normal-open" });
    expect(command.confirmation).toEqual({ kind: "none" });
    expect(command.results[0].schemaRef).toBe("#/schemas/definitions/TaskBlame");
    const event = JSON.parse(await run(["activity", "view", attribution.id, "--json"]));
    expect(taskAttributionSchema.parse(Object.fromEntries(Object.keys(taskAttributionSchema.shape).map(key => [key, event[key]])))).toEqual(attribution);
    expect(snapshot()).toEqual(before);
    expect(await run(["task", "blame", "--help"])).toContain("<task-key>");
    expect(await run(["task", "--help"])).toContain("blame");
  });
});

test("blame distinguishes absent provenance from absent actor identity and follows current key lifetimes", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (args: string[]) => {
      const result = await runZinn(args, directory, first);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    await run(["project", "create", "APP"]);
    const created = JSON.parse(await run(["task", "create", "APP", "--title", "Historical", "--description", "kept", "--json"]));
    withTestDb(directory, db => db.query("UPDATE activity SET actor_name = NULL, actor_source = NULL, actor_session_id = NULL, actor_thread_id = NULL WHERE entity_id = ?").run(created.id));
    const recorded = resultSchemas.TaskBlame.parse(JSON.parse(await run(["task", "blame", created.key, "--json"])));
    expect(recorded.fields.title.attribution).not.toBeNull();
    expect(recorded.fields.title.attribution?.actor_name).toBeNull();
    expect(await run(["task", "blame", created.key])).toContain("unknown");
    withTestDb(directory, db => db.query("DELETE FROM activity WHERE entity_id = ?").run(created.id));
    const missing = resultSchemas.TaskBlame.parse(JSON.parse(await run(["task", "blame", created.key, "--json"])));
    expect(missing.description[0]!.attribution).toBeNull();
    expect(missing.fields.title.attribution).toBeNull();
    expect(await run(["task", "blame", created.key])).toContain("unrecorded");
    await run(["project", "delete", "APP", "--yes"]);
    const deleted = await runZinn(["task", "blame", created.key, "--json"], directory);
    expect(deleted.code).toBe(1);
    expect(deleted.stdout).toBe("");
    expect(JSON.parse(deleted.stderr).error.code).toBe("not_found");
    await run(["project", "create", "APP"]);
    await run(["task", "create", "APP", "--title", "Current"]);
    const current = JSON.parse(await run(["task", "blame", created.key, "--json"]));
    expect(current.task.id).not.toBe(created.id);
    expect(current.fields.title.value).toBe("Current");
    for (const args of [["task", "blame"], ["task", "blame", created.key, "APP-2"], ["task", "blame", "--history", created.key]]) {
      const invalid = await runZinn([...args, "--json"], directory);
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toBe("");
    }
  });
});
