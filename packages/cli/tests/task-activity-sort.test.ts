import { expect, test } from "bun:test";
import { join } from "node:path";
import { parsedRoutes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

test("task list sorts filtered tasks before limiting with unchanged text and JSON fields", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("project", "create", "APP");
    await run("project", "create", "OTHER");
    await run("task", "create", "APP", "--title", "First");
    for (const key of ["APP", "APP", "OTHER"]) {
      await run("task", "create", key, "--title", "Selected", "--column", "Done", "--label", "bug", "--label", "cli");
    }
    await run("task", "archive", "APP-3");
    await Bun.write(join(directory, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
    withTestDb(directory, db => {
      for (const [key, time] of [["APP-1", 40], ["APP-2", 10], ["APP-3", 20], ["OTHER-1", 30]] as const) {
        const [projectKey, number] = key.split("-");
        db.query(`UPDATE activity SET created_at = ? WHERE entity_type = 'task' AND entity_id =
          (SELECT task.id FROM task JOIN project ON project.id = task.project_id WHERE project.key = ? AND task.number = ?)`)
          .run(time, projectKey!, Number(number));
      }
    });
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all());
    const allRows = JSON.parse(await run("task", "list", "--all-projects", "--state", "all", "--all", "--json"));
    const rowsByKey = new Map(allRows.map((row: { key: string }) => [row.key, row]));
    const cases: Array<{ args: Array<string>; keys: Array<string> }> = [
      { args: [], keys: ["APP-1", "APP-2"] },
      { args: ["--all"], keys: ["APP-1", "APP-3", "APP-2"] },
      { args: ["--all-projects"], keys: ["APP-1", "OTHER-1", "APP-2"] },
      { args: ["--all-projects", "--all"], keys: ["APP-1", "OTHER-1", "APP-3", "APP-2"] },
      { args: ["--all-projects", "--archived"], keys: ["APP-3"] },
      { args: ["OTHER"], keys: ["OTHER-1"] },
      { args: ["--all-projects", "--column", "done"], keys: ["OTHER-1", "APP-2"] },
      { args: ["--all-projects", "--all", "--label", "BUG", "--label", "CLI"], keys: ["OTHER-1", "APP-3", "APP-2"] },
      { args: ["app", "--all", "--column", "DONE", "--label", "bug", "--label", "cli"], keys: ["APP-3", "APP-2"] },
      { args: ["APP", "--column", "missing"], keys: [] },
    ];
    for (const { args, keys } of cases) {
      for (const limit of [[], ["--limit", "2"]]) {
        const expectedKeys = limit.length === 0 ? keys : keys.slice(0, 2);
        const sorted = ["task", "list", ...args, "--state", "all", "--sort", "activity", ...limit];
        const json = await runZinn([...sorted, "--json"], directory);
        expect(json.code, json.stderr).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual(expectedKeys.map(key => rowsByKey.get(key)));
        const text = await runZinn(sorted, directory);
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout.trim().split("\n").filter(Boolean).map(line => line.split("|")[0]!.trim())).toEqual(expectedKeys);
        if (keys.length > expectedKeys.length) {
          expect(json.stderr).toContain("--starting-after");
          expect(text.stderr).toContain("--starting-after");
        } else {
          expect(json.stderr).toBe("");
          expect(text.stderr).toBe("");
        }
      }
    }
    expect(JSON.parse(await run("task", "list", "--all-projects", "--state", "all", "--all", "--json"))).toEqual(allRows);
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity ORDER BY id").all())).toEqual(before);
  });
});

test("sort metadata is discoverable and invalid or repeated values fail without writes", async () => {
  await withIsolatedZinnDir(async directory => {
    const route = parsedRoutes.find(route => route.command === "task list")!;
    expect(route.input?.options?.sort?.value).toMatchObject({ kind: "enum", choices: ["activity", "due"] });
    const help = await runZinn(["task", "list", "--help"], directory);
    expect(help.code).toBe(0);
    for (const fact of ["--sort", "activity", "comments", "relations"]) {
      expect(help.stdout).toContain(fact);
    }
    expect((await runZinn(["project", "create", "APP"], directory)).code).toBe(0);
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity").all());
    for (const args of [
      ["--sort=updated"], ["--sort="], ["--sort=Activity"], ["--sort=-activity"],
      ["--sort", "activity", "--sort", "activity"], ["--sort"],
    ]) {
      const result = await runZinn(["task", "list", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_input", details: { argument: "--sort" } });
    }
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity").all())).toEqual(before);
  });
});
