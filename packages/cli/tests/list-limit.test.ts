import { expect, test } from "bun:test";
import { parsedRoutes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

const limitedRoutes = parsedRoutes.filter(route => route.input?.options?.limit !== undefined);

test("every route with --limit accepts the same decimal spellings and limits from 1 through the largest safe integer", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = (...args: string[]) => runZinn([...args, "--json"], directory);
    expect((await run("project", "create", "APP")).code).toBe(0);
    expect((await run("task", "create", "APP", "--title", "needle")).code).toBe(0);
    const before = withTestDb(directory, db => db.query("SELECT * FROM activity").all());
    expect(limitedRoutes.length).toBeGreaterThan(0);
    for (const route of limitedRoutes) {
      const positionals = route.input!.forms[0]!.positionals
        .filter(positional => positional.min > 0)
        .flatMap(positional => Array(positional.min).fill(positional.name === "query" ? "needle" : "APP"));
      const args = [...route.command.split(" "), ...positionals];
      const all = await run(...args);
      expect(all.code).toBe(0);
      expect(Array.isArray(JSON.parse(all.stdout))).toBe(true);
      for (const limit of ["1", "10", "11872", "1000000000000000", String(Number.MAX_SAFE_INTEGER)]) {
        const result = await run(...args, `--limit=${limit}`);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(JSON.parse(all.stdout).slice(0, Number(limit)));
      }
      for (const limit of ["", "0", "-1", "1.5", "1e2", "+1", "01", " 2", "2 ", "Infinity", "NaN", "9007199254740992", "99999999999999999"]) {
        const result = await run(...args, `--limit=${limit}`);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
      }
      const repeated = await run(...args, "--limit", "1", "--limit", "2");
      expect(repeated.code).toBe(1);
      expect(repeated.stdout).toBe("");
    }
    expect(withTestDb(directory, db => db.query("SELECT * FROM activity").all())).toEqual(before);
  });
});

test("task list caps filtered JSON and plain output once across projects", async () => {
  await withIsolatedZinnDir(async directory => {
    const run = async (...args: string[]) => {
      const result = await runZinn(args, directory);
      expect(result.code).toBe(0);
      return result;
    };
    await run("label", "create", "bug");
    await run("label", "create", "cli");
    for (const key of ["APP", "OTHER"]) {
      await run("project", "create", key);
      await run("task", "create", key, "--title", "Skip");
      for (let index = 0; index < 3; index++) {
        await run("task", "create", key, "--title", "needle", "--label", "bug", "--label", "cli", "--column", "Done");
      }
      await run("task", "archive", `${key}-4`);
    }
    for (const scope of [["APP"], ["--all-projects"]]) {
      for (const archive of [[], ["--all"], ["--archived"]]) {
        const args = ["task", "list", ...scope, ...archive, "--label", "BUG", "--label", "CLI", "--column", "done", "--state", "all"];
        const all = JSON.parse((await run(...args, "--json")).stdout);
        expect(all.length).toBeGreaterThan(0);
        expect(JSON.parse((await run(...args, "--limit", "1", "--json")).stdout)).toEqual(all.slice(0, 1));
        const text = (await run(...args, "--limit", "1")).stdout;
        expect(text).toContain(all[0].key);
        for (const omitted of all.slice(1)) {
          expect(text).not.toContain(omitted.key);
        }
      }
    }
    const search = await run("task", "search", "needle", "--limit", "1", "--json");
    expect(JSON.parse(search.stdout)).toHaveLength(1);
    expect(search.stderr).toContain("2");
  });
});
