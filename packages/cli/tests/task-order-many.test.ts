import { expect, test } from "bun:test";
import { errorDocumentSchema } from "../src/errors";
import { parsedRoutes } from "../src/routes/routes";
import { runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";

async function seed(directory: string) {
  for (const args of [
    ["project", "create", "APP"],
    ...["First", "Second", "Third", "Fourth"].map(title => ["task", "create", "APP", "--title", title]),
  ]) {
    expect((await runZinn(args, directory)).code).toBe(0);
  }
}

function snapshot(directory: string) {
  return withTestDb(directory, db => ({
    tasks: db.query("SELECT * FROM task ORDER BY id").all(),
    activity: db.query("SELECT * FROM activity ORDER BY id").all(),
  }));
}

async function keys(directory: string) {
  const result = await runZinn(["task", "list", "APP", "--json"], directory);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).map((entry: { key: string }) => entry.key);
}

test("bulk task order reports each step and retains the single-task JSON object", async () => {
  for (const json of [false, true]) {
    await withIsolatedZinnDir(async directory => {
      await seed(directory);
      expect((await runZinn(["task", "order", "APP-3", "before", "APP-2"], directory)).code).toBe(0);
      const before = snapshot(directory);
      const result = await runZinn(["task", "order", "app-1", "APP-2", "top", ...(json ? ["--json"] : [])], directory);
      expect(result.code).toBe(0);
      expect(await keys(directory)).toEqual(["APP-1", "APP-2", "APP-3", "APP-4"]);
      const after = snapshot(directory);
      expect(after.activity.length).toBe(before.activity.length + 1);
      if (json) {
        const value = JSON.parse(result.stdout);
        expect(value.map((entry: { key: string; changed: boolean }) => ({ key: entry.key, changed: entry.changed })))
          .toEqual([{ key: "APP-1", changed: false }, { key: "APP-2", changed: true }]);
        expect(value.every((entry: { id?: string }) => typeof entry.id === "string")).toBe(true);
      } else {
        expect(result.stdout).toContain("APP-1");
        expect(result.stdout).toContain("APP-2");
        expect(result.stderr).toContain("APP-1");
        expect(result.stderr).not.toContain("APP-2");
      }
      const single = await runZinn(["task", "order", "APP-1", "top", "--json"], directory);
      expect(single.code).toBe(0);
      expect(JSON.parse(single.stdout)).toMatchObject({ key: "APP-1", changed: false });
      const noOps = await runZinn(["task", "order", "APP-1", "APP-2", "top", "--json"], directory);
      expect(noOps.code).toBe(0);
      expect(JSON.parse(noOps.stdout).map((entry: { changed: boolean }) => entry.changed)).toEqual([false, false]);
      expect(snapshot(directory)).toEqual(after);
    });
  }
});

test("bulk task order accepts all four block placements and separators", async () => {
  const cases: Record<string, { placement: string[]; order: string[] }> = {
    top: { placement: ["top"], order: ["APP-4", "APP-2", "APP-1", "APP-3"] },
    bottom: { placement: ["bottom"], order: ["APP-1", "APP-3", "APP-4", "APP-2"] },
    before: { placement: ["before", "APP-3"], order: ["APP-1", "APP-4", "APP-2", "APP-3"] },
    after: { placement: ["after", "APP-3"], order: ["APP-1", "APP-3", "APP-4", "APP-2"] },
  };
  const input = parsedRoutes.find(route => route.command === "task order")!.input;
  const directions = input.forms.filter(form => form.positionals[0]!.max === null)
    .flatMap(form => form.positionals.find(item => item.name === "direction")!.value.choices!);
  for (const direction of directions) {
    expect(cases[direction]).toBeDefined();
    const { placement, order } = cases[direction]!;
    await withIsolatedZinnDir(async directory => {
      await seed(directory);
      const result = await runZinn(["--json", "task", "order", "--", "APP-4", "APP-2", ...placement], directory);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).map((entry: { key: string }) => entry.key)).toEqual(["APP-4", "APP-2"]);
      expect(await keys(directory)).toEqual(order);
    });
  }
});

test("bulk task order refuses invalid batches without changing tasks or activity", async () => {
  await withIsolatedZinnDir(async directory => {
    await seed(directory);
    for (const args of [
      ["project", "create", "OTHER"],
      ["task", "create", "OTHER", "--title", "Other"],
      ["task", "move", "APP-3", "TODO"],
      ["task", "archive", "APP-4"],
    ]) {
      expect((await runZinn(args, directory)).code).toBe(0);
    }
    const before = snapshot(directory);
    for (const args of [
      ["APP-2", "APP-99", "top"],
      ["APP-2", "invalid-key", "top"],
      ["APP-2", "OTHER-1", "top"],
      ["APP-2", "APP-3", "top"],
      ["APP-2", "APP-4", "top"],
      ["APP-2", "app-2", "top"],
      ["APP-2", "APP-1", "before", "app-2"],
      ["APP-2", "APP-1", "after", "APP-1"],
      ["APP-2", "APP-1", "up"],
      ["APP-2", "APP-1", "down"],
      ["APP-2", "APP-1", "before"],
      ["APP-2", "APP-1", "sideways"],
      ["APP-2", "APP-1", "top", "APP-3"],
      ["APP-2", "APP-1", "before", "APP-3", "extra"],
      ["APP-2", "APP-1", "top", "--bogus"],
    ]) {
      const result = await runZinn(["task", "order", ...args, "--json"], directory);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      errorDocumentSchema.parse(JSON.parse(result.stderr));
      expect(snapshot(directory)).toEqual(before);
    }
  });
});
