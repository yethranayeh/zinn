import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { errorDocumentSchema } from "../src/errors";
import { runZinn, withIsolatedZinnDir } from "../test-helpers";

test("task search adds text excerpts and keeps the ordinary JSON task list", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    await run("project", "create", "FIND");
    await run("task", "create", "FIND", "--title", "Refine the numbers", "--description", "Quarterly quota", "--priority", "high");
    await run("task", "create", "FIND", "--title", "Unrelated");
    await run("task", "comment", "create", "FIND-2", "--text", "Blocked on refinement tools");

    const result = await run("task", "search", "REFIN");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("FIND-1 | Backlog | H | Refine the numbers");
    expect(result.stdout).toContain("Title | Refine the numbers");
    expect(result.stdout).toContain("FIND-2 | Backlog | - | Unrelated");
    expect(result.stdout).toContain("Comment FIND-2#1 | Blocked on refinement tools");
    expect(result.stdout).toBe(stripVTControlCharacters(result.stdout));

    const colored = await runZinn(["task", "search", "REFIN"], dir, { FORCE_COLOR: "1" });
    expect(stripVTControlCharacters(colored.stdout)).toBe(result.stdout);
    expect(colored.stdout).toMatch(/on (?:\x1b\[[\d;]+m)+refinement\x1b\[/);

    const noColor = await runZinn(["task", "search", "REFIN"], dir, { NO_COLOR: "1" });
    expect(noColor.stdout).toBe(result.stdout);

    const listed = JSON.parse((await run("task", "list", "FIND", "--json")).stdout);
    const searched = JSON.parse((await run("task", "search", "refine quota", "--json")).stdout);
    expect(searched).toEqual([listed[0]]);
    const enriched = await run("task", "search", "refine quota", "--json", "--with-matches");
    expect(enriched.code).toBe(0);
    expect(enriched.stderr).toBe("");
    expect(JSON.parse(enriched.stdout)).toEqual([{ ...listed[0], matches: [
      { field: "title", snippet: "Refine the numbers", highlights: [[0, 6]] },
      { field: "description", snippet: "Quarterly quota", highlights: [[10, 15]] },
    ] }]);
  });
});

test("task search shows why a description-only result matched", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    const description = "Quarterly refinement checklist";
    await run("project", "create", "SEEK");
    await run("label", "create", "ops");
    await run("task", "create", "SEEK", "--title", "Calibrate sensors", "--description", description, "--label", "ops");
    await run("task", "create", "SEEK", "--title", "Unrelated");

    const result = await run("task", "search", "checklist");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("SEEK-1 | Backlog | - | Calibrate sensors | ops");
    expect(result.stdout).toContain(`Description | ${description}`);

    expect(JSON.parse((await run("task", "search", "checklist", "--json")).stdout)).toEqual([
      expect.objectContaining({ key: "SEEK-1", description, labels: ["ops"] }),
    ]);
  });
});

test("task search filters by exact column name", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    await run("project", "create", "COLS");
    await run("project", "create", "MORE");
    await run("task", "create", "COLS", "--title", "Alpha checklist");
    await run("task", "create", "COLS", "--title", "Beta checklist", "--column", "Done");
    await run("task", "create", "COLS", "--title", "Gamma checklist", "--column", "Review");
    await run("task", "create", "MORE", "--title", "Delta checklist", "--column", "done");

    const scoped = JSON.parse(
      (await run("task", "search", "checklist", "COLS", "--column", "done", "--json")).stdout,
    );
    expect(scoped.map((entry: { key: string }) => entry.key)).toEqual(["COLS-2"]);

    const acrossProjects = JSON.parse(
      (await run("task", "search", "checklist", "--column", "DONE", "--json")).stdout,
    );
    expect(acrossProjects.map((entry: { key: string }) => entry.key).sort()).toEqual([
      "COLS-2",
      "MORE-1",
    ]);

    expect((await run("task", "search", "checklist", "COLS", "--column", "Nope")).stdout).toBe("");
    expect((await run("task", "search", "checklist", "COLS", "--column", "Review")).stdout).toContain(
      "COLS-3",
    );
  });
});

test("task search with no matches exits zero without output", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "EMPTY"], dir);
    await runZinn(["task", "create", "EMPTY", "--title", "Something"], dir);

    expect(await runZinn(["task", "search", "nothing"], dir)).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await runZinn(["task", "search", "nothing", "--json"], dir)).toEqual({
      stdout: "[]\n",
      stderr: "",
      code: 0,
    });
  });
});

test("task search treats FTS syntax as text and accepts a leading dash after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SYN"], dir);
    await runZinn(["task", "create", "SYN", "--title", "Fix sign-in (again)", "--description", "AND NOT"], dir);

    for (const query of ["-", '"', ":", "(", "AND", "NOT", "*", 'sign-in "', "NEAR(a b)"]) {
      const result = await runZinn(["task", "search", "--", query], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }

    expect((await runZinn(["task", "search", "--", "-sign"], dir)).stdout).toContain("SYN-1");
    expect((await runZinn(["task", "search", "(again) and not"], dir)).stdout).toContain("SYN-1");
  });
});

test("task search treats --json and --help after -- as literal query text, not router flags", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "ESC"], dir);
    await runZinn(["task", "create", "ESC", "--title", "Something"], dir);

    // Neither literal query matches any task; JSON mode would print "[]\n"
    // and a help request would print usage text, so empty output on both
    // stdout and stderr confirms "--json"/"--help" were searched for, not acted on.
    expect(await runZinn(["task", "search", "--", "--json"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(await runZinn(["task", "search", "--", "--help"], dir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
  });
});

test("task search pins an exact task key before text matches", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "PIN"], dir);
    await runZinn(["task", "create", "PIN", "--title", "Mentions pin-2 first"], dir);
    await runZinn(["task", "create", "PIN", "--title", "The pinned task"], dir);

    const keys = JSON.parse((await runZinn(["task", "search", "pin-2", "--json"], dir)).stdout).map(
      (entry: { key: string }) => entry.key,
    );
    expect(keys).toEqual(["PIN-2", "PIN-1"]);
  });
});

test("task search hides archived matches with a stderr hint and filters by project and limit", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: Array<string>) => runZinn(args, dir);
    await run("project", "create", "ONE");
    await run("project", "create", "TWO");
    await run("task", "create", "ONE", "--title", "Widget active");
    await run("task", "create", "ONE", "--title", "Widget archived");
    await run("task", "create", "ONE", "--title", "Widget also archived");
    await run("task", "create", "TWO", "--title", "Widget elsewhere");
    await run("task", "archive", "ONE-2");
    await run("task", "archive", "ONE-3");

    const active = await run("task", "search", "widget", "one");
    expect(active.code).toBe(0);
    expect(active.stdout).toContain("ONE-1 | Backlog | - | Widget active");
    expect(active.stderr).toContain("2");
    expect(active.stderr).toContain("--all");

    const activeJson = await run("task", "search", "widget", "ONE", "--json");
    expect(JSON.parse(activeJson.stdout)).toHaveLength(1);
    expect(activeJson.stdout).not.toContain("hidden");
    expect(activeJson.stderr).toContain("2");
    expect(activeJson.stderr).toContain("--all");

    const single = await run("task", "search", "ONE-2", "ONE");
    expect(single.stdout).toBe("");
    expect(single.stderr).toContain("1");
    expect(single.stderr).toContain("--all");

    const archived = await run("task", "search", "widget", "ONE", "--archived");
    expect(archived.stderr).toBe("");
    expect(archived.stdout.trimEnd().split("\n").filter((line) => line.startsWith("ONE-")).sort()).toEqual([
      `ONE-2 | Backlog | - | Widget archived`,
      `ONE-3 | Backlog | - | Widget also archived`,
    ]);

    const all = await run("task", "search", "widget", "--all");
    expect(all.stderr).toBe("");
    expect(all.stdout.trimEnd().split("\n").filter((line) => /^\w+-\d+ /.test(line))).toHaveLength(4);
    expect(all.stdout).toContain(`ONE-2 | Archived | Backlog | - | Widget archived`);
    expect(all.stdout).toContain(`TWO-1 | Active   | Backlog | - | Widget elsewhere`);

    const limited = await run("task", "search", "widget", "--all", "--limit", "3");
    expect(limited.stdout.trimEnd().split("\n").filter((line) => /^\w+-\d+ /.test(line))).toHaveLength(3);
    expect((await run("task", "search", "widget", "TWO")).stdout).toContain("TWO-1 | Backlog | - | Widget elsewhere");
  });
});

test("task search validates its arguments", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "VAL"], dir);
    const matchesWithoutJson = await runZinn(["task", "search", "a", "--with-matches"], dir);
    expect(matchesWithoutJson.code).toBe(1);
    expect(matchesWithoutJson.stdout).toBe("");
    expect(matchesWithoutJson.stderr).toContain("--json");
    expect(matchesWithoutJson.stderr).toContain("--with-matches");

    const usage = "Usage: zinn task search";
    const cases = [
      [[], { code: "invalid_input", details: { argument: "query" }, help: expect.stringContaining(usage) }],
      [[""], { code: "invalid_input", details: { field: ["query"] } }],
      [["\uE000", "--with-matches"], { code: "invalid_input", details: { field: ["query"] } }],
      [["a", "VAL", "extra"], { code: "invalid_input", message: expect.stringContaining("extra"), details: { field: [] }, help: expect.stringContaining(usage) }],
      [["a", "--archived", "--all"], { code: "invalid_input", details: { argument: "--archived" } }],
      [["a", "--limit", "0"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "two"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "0x5"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "1e1"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", " 5 "], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "5."], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "--limit", "1", "--limit", "2"], { code: "invalid_input", details: { argument: "--limit" } }],
      [["a", "MISSING"], { code: "not_found", details: { entity: "project", key: "MISSING" } }],
    ] as const;
    for (const [args, expected] of cases) {
      const result = await runZinn(["task", "search", ...args, "--json"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject(expected);
    }
  });
});
