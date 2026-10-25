import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorDocumentSchema } from "../src/errors";
import { resultSchemas } from "../src/result-schemas";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("activity time flags select exact instants across timezones and combine before limit", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory, { ZINN_SESSION_ID: "Session", ZINN_THREAD_ID: "Thread" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const list = async (...flags: string[]) => resultSchemas.ActivityList.parse(JSON.parse(await run("activity", "list", ...flags, "--json")));
    await run("project", "create", "APP");
    await run("task", "create", "APP", "--title", "First");
    await run("task", "edit", "APP-1", "--priority", "high");
    await run("task", "comment", "create", "APP-1", "--text", "Complete comment\n");
    await run("task", "create", "APP", "--title", "Second");
    const base = 1_792_929_600_000;
    const oldestFirst = (await list()).reverse();
    withTestDb(directory, db => {
      for (const [index, event] of oldestFirst.entries()) {
        event.created_at = base + index * 100;
        db.query("UPDATE activity SET created_at = ? WHERE id = ?").run(event.created_at, event.id);
      }
    });
    const before = await list();
    const selected = before.filter(event => event.created_at >= base + 100 && event.created_at <= base + 300);
    const bounds = ["--since", "2026-10-25T12:00:00.1Z", "--until", "2026-10-25T13:00:00.3+01:00"];
    expect(await list(...bounds)).toEqual(selected);
    expect(await list("--since", "2026-10-25T00:00:00Z", "--until", "2026-10-25T12:00:00Z"))
      .toEqual([oldestFirst[0]!]);
    expect(await list("--since", String(base + 100))).toEqual(before.filter(event => event.created_at >= base + 100));
    expect(await list("--until", String(base + 300))).toEqual(before.filter(event => event.created_at <= base + 300));
    expect(await list("--since", String(base + 200), "--until", String(base + 200))).toEqual([oldestFirst[2]!]);
    for (const flags of [["--task", "APP-1"], ["--task-id", oldestFirst[1]!.entity_id], ["--project", "APP"], ["--project-id", oldestFirst[0]!.entity_id]]) {
      expect(await list(...bounds, ...flags)).toEqual(selected);
    }
    expect(await list(...bounds, "--session", "Session", "--thread", "Thread", "--action", "edit", "--changed", "priority=high", "--limit", "1"))
      .toEqual([oldestFirst[2]!]);
    expect(await list(...bounds, "--limit", "1")).toEqual(selected.slice(0, 1));
    const text = await run("activity", "list", ...bounds);
    expect(text).toContain("APP-1");
    expect(text).not.toContain("APP-2");
    for (const TZ of ["UTC", "Europe/Berlin", "America/New_York"]) {
      const result = await runZinn(["activity", "list", ...bounds, "--json"], directory, { TZ });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(selected);
    }
    expect(await list("--until=-1")).toEqual([]);
    expect(await list("--since=8640000000000000")).toEqual([]);
    expect(await list()).toEqual(before);
  });
});

test("invalid time flags report the argument without opening storage", async () => {
  await withIsolatedZinnDir(async directory => {
    for (const flag of ["--since", "--until"]) {
      const cases = [
        ...["", "today", "2026-10-25", "2026-10-25T12:00:00", "2026-02-29T00:00:00Z", "2026-10-25T24:00:00Z", "2016-12-31T23:59:60Z", "2026-10-25T12:00:00.1234Z", "8640000000000001", "1.5"].map(value => [`${flag}=${value}`]),
        [flag], [flag, "0", flag, "1"],
      ];
      for (const flags of cases) {
        const result = await runZinn(["activity", "list", ...flags, "--json"], directory);
        expect(result.code, flags.join(" ")).toBe(1);
        expect(result.stdout).toBe("");
        const error = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
        expect(error.code).toBe("invalid_input");
        expect(error.details?.argument).toBe(flag);
      }
    }
    const reversed = await runZinn(["activity", "list", "--since", "1", "--until", "0", "--json"], directory);
    expect(reversed.code).toBe(1);
    expect(reversed.stdout).toBe("");
    const error = errorDocumentSchema.parse(JSON.parse(reversed.stderr)).error;
    expect(error.code).toBe("invalid_input");
    expect(error.details?.argument).toBe("--until");
    expect(error.details?.field).toEqual(["until"]);
    expect(existsSync(join(directory, "data"))).toBe(false);
  });
});
