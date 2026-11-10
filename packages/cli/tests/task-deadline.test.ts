import { expect, test } from "bun:test";
import { parsedRoutes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("deadline CLI create, edit, clear, activity and shared task JSON preserve exact instants", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory, { TZ: "America/New_York" });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const json = async (...args: string[]) => JSON.parse(await run(...args, "--json"));
    await run("project", "create", "APP");
    const undated = await json("task", "create", "APP", "--title", "Undated", "--due", "NoNe");
    expect(undated.due_at).toBeNull();
    const time = "2026-10-25T12:34:56.123Z";
    const created = await json("task", "create", "APP", "--title", "Dated", "--due", time);
    expect(created.due_at).toBe(Date.parse(time));
    const same = await json("task", "edit", "APP-2", "--due", "2026-10-25T13:34:56.123+01:00");
    expect(same).toMatchObject({ due_at: created.due_at, updated_at: created.updated_at, changed: false });
    for (const args of [["task", "view", "APP-2"], ["task", "list", "APP"], ["task", "search", "Dated", "APP"]]) {
      const result = await json(...args);
      expect((Array.isArray(result) ? result.find(row => row.key === "APP-2") : result).due_at).toBe(created.due_at);
      expect(await run(...args)).toContain("2026-10-25 08:34:56.123 -04:00");
    }
    expect(await json("task", "edit", "APP-2", "--due=0")).toMatchObject({ due_at: 0, changed: true });
    expect(await json("task", "edit", "APP-2", "--title", "Renamed")).toMatchObject({ due_at: 0 });
    const cleared = await json("task", "edit", "APP-2", "--due", "NONE");
    expect(cleared).toMatchObject({ due_at: null, changed: true });
    expect(await json("task", "edit", "APP-2", "--due", "none")).toMatchObject({ due_at: null, updated_at: cleared.updated_at, changed: false });
    const events = await json("activity", "list", "--task", "APP-2", "--changed", "due_at");
    expect(events).toHaveLength(3);
    expect(events[0].changes.due_at).toEqual([0, null]);
    expect(events[1].changes.due_at).toEqual([created.due_at, 0]);
    expect(events[2].changes.due_at).toBe(created.due_at);
    const clearedActivity = await run("activity", "view", events[0].id);
    expect(clearedActivity).toContain("1969-12-31 19:00:00 -05:00");
    const activityText = await run("activity", "list", "--task", "APP-2", "--action", "edit", "--changed", "due_at");
    expect(activityText).toContain("1969-12-31 19:00:00 -05:00");
    expect(await run("task", "view", "APP-2", "--history")).toContain("1969-12-31 19:00:00 -05:00");
    const initialActivity = await run("activity", "view", events[2].id);
    expect(initialActivity).toContain("2026-10-25 08:34:56.123 -04:00");
    for (const [fraction, expected] of [[".000", "12:34:56 +00:00"], [".010", "12:34:56.010 +00:00"]]) {
      const result = await runZinn(["task", "edit", "APP-2", "--due", `2026-10-25T12:34:56${fraction}Z`], directory, { TZ: "UTC" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected!);
    }
  });
});

test("deadline CLI filters precede limits and key pinning, while due sorting preserves board ties", async () => {
  await withIsolatedZinnDir(async directory => {
    const json = async (...args: string[]) => {
      const result = await runZinn([...args, "--json"], directory);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const keys = async (...args: string[]) => (await json(...args)).map((row: { key: string }) => row.key);
    await json("project", "create", "APP");
    await json("project", "create", "OTHER");
    await json("label", "create", "selected");
    for (const due of ["none", "20", "0", "0", "-1"]) {
      await json("task", "create", "APP", "--title", "Needle", `--due=${due}`, "--label", "selected");
    }
    await json("task", "create", "OTHER", "--title", "Needle", "--due=0");
    await json("task", "move", "APP-4", "Done");
    const board = await keys("task", "list", "APP", "--state", "all");
    expect(await keys("task", "list", "APP", "--state", "all", "--sort", "due")).toEqual(["APP-5", "APP-3", "APP-4", "APP-2", "APP-1"]);
    const bounds = ["--due-since=0", "--due-until=0", "--label", "SELECTED", "--limit", "1"];
    for (const args of [["task", "list", "APP", "--state", "all"], ["task", "search", "Needle", "APP"]]) {
      expect(await keys(...args, ...bounds)).toEqual(["APP-3"]);
      expect(await keys(...args, "--due-until=-1")).toEqual(["APP-5"]);
    }
    expect(await keys("task", "list", "APP", "--state", "all", "--column", "done", ...bounds)).toEqual(["APP-4"]);
    for (const key of ["APP-1", "APP-2"]) {
      expect(await keys("task", "search", key, ...bounds)).toEqual([]);
    }
    expect(await keys("task", "list", "APP", "--state", "all")).toEqual(board);
  });
});

test("deadline CLI metadata and invalid inputs cover all new options without writes", async () => {
  await withIsolatedZinnDir(async directory => {
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    expect((await runZinn(["task", "create", "APP", "--title", "Existing"], directory)).code).toBe(0);
    const snapshot = () => withTestDb(directory, db => ({
      tasks: db.query("SELECT * FROM task").all(), activity: db.query("SELECT * FROM activity").all(),
    }));
    const before = snapshot();
    for (const command of ["task create", "task edit", "task list", "task search"]) {
      const route = parsedRoutes.find(route => route.command === command)!;
      const flags = command === "task create" || command === "task edit" ? ["due"] : ["due-since", "due-until"];
      for (const flag of flags) {
        expect(route.input!.options[flag]!.value).toMatchObject({ kind: "timestamp" });
      }
    }
    for (const value of ["", "2026-10-25", "2026-10-25T12:00:00", "2026-02-29T12:00:00Z", "2026-10-25T24:00:00Z", "2016-12-31T23:59:60Z", "2026-10-25T12:00:00.1234Z", "1.1", "8640000000000001"]) {
      for (const args of [["task", "create", "APP", "--title", "Invalid", `--due=${value}`], ["task", "edit", "APP-1", `--due=${value}`], ["task", "list", "APP", `--due-since=${value}`], ["task", "search", "Existing", "APP", `--due-until=${value}`]]) {
        const result = await runZinn([...args, "--json"], directory);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      }
    }
    for (const args of [["task", "list", "APP"], ["task", "search", "Existing", "APP"]]) {
      const result = await runZinn([...args, "--due-since=1", "--due-until=0", "--json"], directory);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.details.argument).toBe("--due-until");
    }
    const changed = await runZinn(["activity", "list", "--changed", "due_at=none", "--json"], directory);
    expect(changed.code).toBe(1);
    expect(snapshot()).toEqual(before);
  });
});
