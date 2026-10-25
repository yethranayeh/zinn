import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Activity } from "@zinn-dev/core";
import { activityActionSchema, activityChangedFieldSchema } from "@zinn-dev/core";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("action flags select recorded actions and combine with field and identity filters", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const list = async (...flags: string[]): Promise<Activity[]> => JSON.parse(await run("activity", "list", ...flags, "--json"));
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "Item");
    await run("task", "edit", "APP-1", "--priority", "high");
    await run("task", "comment", "create", "APP-1", "--text", "Comment");
    await run("task", "comment", "edit", "APP-1#1", "--text", "Revised comment");
    await run("task", "comment", "delete", "APP-1#1", "--yes");
    const before = await list();
    for (const action of activityActionSchema.options) {
      expect(await list("--action", action)).toEqual(before.filter(event => event.action === action));
    }
    const selected = before.filter(event => event.action === "edit" || event.action === "comment_create");
    expect(await list("--action", "edit", "--action", "comment_create")).toEqual(selected);
    expect(await list("--action", "edit", "--action", "comment_create", "--limit", "1")).toEqual(selected.slice(0, 1));
    expect(await list("--action", "edit", "--task", "APP-1", "--changed", "priority=high"))
      .toEqual(before.filter(event => event.action === "edit"));
    expect(await list()).toEqual(before);
    expect(await run("activity", "list", "--action", "comment_create")).toContain("APP-1");
  });
});

test("invalid actions fail before opening storage", async () => {
  await withIsolatedZinnDir(async directory => {
    for (const action of ["", "unknown", "EDIT"]) {
      const result = await runZinn(["activity", "list", "--action", action, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(failure.code).toBe("invalid_input");
      expect(failure.details?.argument).toBe("--action");
      for (const known of activityActionSchema.options) {
        expect(failure.message).toContain(known);
      }
    }
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});

test("activity changed flags match new values and added labels with repeated and combined filters", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: "Session", ZINN_THREAD_ID: "Thread" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const list = async (...flags: string[]): Promise<Activity[]> => {
      const events = JSON.parse(await run("activity", "list", ...flags, "--json"));
      resultSchemas.ActivityList.parse(events);
      return events;
    };
    await run("project", "create", "APP");
    await run("label", "create", "bug");
    await run("label", "create", "needs=review");
    await run("task", "create", "APP", "--title", "Initial", "--column", "Review", "--priority", "high", "--label", "bug");
    const created = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--title", "Keeps label", "--add-label", "bug");
    await run("task", "edit", "APP-1", "--priority", "low");
    const lowered = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--priority", "high", "--add-label", "needs=review");
    const combined = (await list("--task", "APP-1"))[0]!;
    await run("task", "move", "APP-1", "Done");
    const moved = (await list("--task", "APP-1"))[0]!;
    await run("task", "label", "remove", "APP-1", "bug");
    const removed = (await list("--task", "APP-1"))[0]!;
    await run("task", "comment", "create", "APP-1", "--text", "priority=high labels=bug");
    await run("task", "create", "APP", "--title", "Unrelated", "--priority", "urgent");
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());

    expect(await list("--changed", "priority=HIGH")).toEqual([combined, created]);
    expect(await list("--changed", "column=review")).toEqual([created]);
    expect(await list("--changed", "labels=BUG")).toEqual([created]);
    expect(await list("--changed", "labels")).toEqual([removed, combined, created]);
    expect(await list("--changed", "labels", "--changed", "labels=missing")).toEqual([removed, combined, created]);
    expect(await list("--action", "edit", "--changed", "labels", "--changed", "priority=high")).toEqual([combined]);
    expect(await list("--changed=labels=needs=review")).toEqual([combined]);
    expect(await list("--changed", "priority=high", "--changed", "priority=low")).toEqual([combined, lowered, created]);
    expect(await list("--changed", "column=Review", "--changed", "column=Done")).toEqual([moved, created]);
    expect(await list("--changed", "labels=bug", "--changed", "labels=needs=review")).toEqual([combined, created]);
    expect(await list("--changed", "priority=high", "--changed", "labels=needs=review")).toEqual([combined]);
    expect(await list("--changed", "priority=high", "--changed", "labels=bug")).toEqual([created]);
    expect(await list("--task", "APP-1", "--session", "Session", "--thread", "Thread", "--changed", "priority=high", "--limit", "1")).toEqual([combined]);
    expect(await list("--project", "APP", "--changed", "priority=high", "--limit", "1")).toEqual([combined]);
    expect(await list("--task-id", created.entity_id, "--changed", "column=Review")).toEqual([created]);
    expect(await list("--task", "APP-1", "--thread", "thread", "--changed", "priority=high")).toEqual([]);
    expect(await list("--changed", "labels=missing")).toEqual([]);
    expect(await run("activity", "list", "--changed", "labels=missing")).toBe("");
    const text = await run("activity", "list", "--changed", "column=Review");
    expect(text).toContain("APP-1");
    expect(text).toContain("Review");
    expect(text).not.toContain("APP-2");
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
  });
});

test("priority=none matches clearing and creation while column and label none remain names", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const list = async (...flags: string[]): Promise<Activity[]> => JSON.parse(await run("activity", "list", ...flags, "--json"));
    await run("project", "create", "APP");
    await run("project", "column", "create", "APP", "none");
    await run("label", "create", "none");
    await run("task", "create", "APP", "--title", "Unassigned", "--column", "none", "--label", "none");
    const created = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--priority", "high");
    const prioritized = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--priority", "none");
    const cleared = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--title", "Still unassigned");
    const renamed = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--description", "Description");
    const described = (await list("--task", "APP-1"))[0]!;
    await run("task", "edit", "APP-1", "--description", "");
    const descriptionCleared = (await list("--task", "APP-1"))[0]!;

    expect(await list("--changed", "priority=NoNe")).toEqual([cleared, created]);
    expect(await list("--changed", "priority")).toEqual([cleared, prioritized, created]);
    expect(await list("--changed", "title")).toEqual([renamed, created]);
    expect(await list("--changed", "description")).toEqual([descriptionCleared, described, created]);
    expect(await list("--action", "edit", "--changed", "description")).toEqual([descriptionCleared, described]);
    expect(await list("--action", "edit", "--changed", "title", "--changed", "description")).toEqual([]);
    expect(await list("--changed", "priority=none", "--changed", "priority=HIGH")).toEqual([cleared, prioritized, created]);
    expect(await list("--changed", "column=NONE", "--changed", "labels=none", "--changed", "priority=none")).toEqual([created]);
  });
});

test("changed flag errors identify the flag and accepted fields before opening storage", async () => {
  await withIsolatedZinnDir(async directory => {
    for (const value of ["title=value", "description=text", "unknown=value", "Column=Review", "column=", "=Review", ""]) {
      const result = await runZinn(["activity", "list", "--changed", value, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(failure.code).toBe("invalid_input");
      expect(failure.details?.argument).toBe("--changed");
      if (["unknown=value", "Column=Review"].includes(value)) {
        for (const field of activityChangedFieldSchema.options) {
          expect(failure.message).toContain(field);
        }
      }
    }
    const text = await runZinn(["activity", "list", "--changed", "unknown=value"], directory);
    expect(text.code).toBe(1);
    expect(text.stdout).toBe("");
    for (const field of activityChangedFieldSchema.options) {
      expect(text.stderr).toContain(field);
    }
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});

test("activity help exposes repeatable changed syntax and the accepted fields", async () => {
  await withIsolatedZinnDir(async directory => {
    const result = await runZinn(["activity", "list", "--help"], directory);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[--changed <field[=value]>]...");
    expect(result.stdout).toContain("--action");
    for (const field of activityChangedFieldSchema.options) {
      expect(result.stdout).toContain(field);
    }
    expect(result.stdout).toContain("priority=none");
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});
