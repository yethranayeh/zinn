import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsedRoutes } from "../src/routes/routes";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withTestDb } from "../test-helpers";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";

function extractContinuation(stderr: string) {
  const commandStart = stderr.indexOf("zinn task list");
  expect(commandStart).toBeGreaterThanOrEqual(0);
  return stderr.slice(commandStart).trimEnd();
}

function jsonError(stderr: string) {
  return JSON.parse(stderr).error as {
    code: string;
    details?: Record<string, unknown>;
  };
}

function canonicalPrefix(id: string, hexLength: number) {
  const hex = id.replaceAll("-", "").slice(0, hexLength);
  const segments: Array<string> = [];
  let offset = 0;

  for (const segmentLength of [8, 4, 4, 4, 12]) {
    const length = Math.min(segmentLength, hex.length - offset);
    if (length <= 0) {
      break;
    }

    segments.push(hex.slice(offset, offset + length));
    offset += length;
  }

  return segments.join("-");
}

function executeContinuation(directory: string, command: string) {
  return runProcessAsync(
    ["/bin/sh", "-c", `zinn() { bun "$ZINN_TEST_CLI" "$@"; }\n${command}`],
    {
      cwd: directory,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, ZINN_TEST_CLI: CLI_PATH },
    },
  );
}

test("task list continuation preserves filters, project scope, router flags and shell quoting", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const specialColumn = "-Needs ' review $(touch task-pagination-injected) `touch task-pagination-injected`";
    const run = async (...args: Array<string>) => {
      const result = await runZinn(args, directory);
      expect(result.code, result.stderr).toBe(0);
      return result;
    };
    const json = async (...args: Array<string>) => {
      const result = await run(...args, "--json");
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Array<{ id: string; key: string }>;
    };

    await run("label", "create", "bug");
    await run("label", "create", "cli");
    await run("project", "create", "APP");
    await run("project", "create", "OTHER");
    await run("project", "column", "create", "APP", "--", specialColumn);
    await run("project", "column", "create", "OTHER", "--", specialColumn);
    for (const dueAt of [0, 10, 20, 30, 40]) {
      await run(
        "task",
        "create",
        "APP",
        "--title",
        `APP ${dueAt}`,
        `--due=${dueAt}`,
        "--label",
        "bug",
        "--label",
        "cli",
        `--column=${specialColumn}`,
      );
    }
    await run(
      "task",
      "create",
      "OTHER",
      "--title",
      "OTHER 5",
      "--due=5",
      "--label",
      "bug",
      "--label",
      "cli",
      `--column=${specialColumn}`,
    );

    const filters = [
      "--limit",
      "2",
      "--sort",
      "due",
      "--label",
      "bug",
      "--label",
      "cli",
      `--column=${specialColumn}`,
      "--due-since=0",
      "--due-until=20",
    ];
    await Bun.write(join(directory, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
    const expectedApp = await json(
      "task",
      "list",
      "--label",
      "bug",
      "--label",
      "cli",
      `--column=${specialColumn}`,
      "--due-since=0",
      "--due-until=20",
      "--sort",
      "due",
    );
    const appPage = await run("task", "list", ...filters, "--json", "--allow-legacy-read");
    expect(appPage.code, appPage.stderr).toBe(0);
    expect(JSON.parse(appPage.stdout)).toEqual(expectedApp.slice(0, 2));
    const appCommand = extractContinuation(appPage.stderr);
    expect(appCommand).toContain(" APP ");
    expect(appCommand).toContain("--json");
    expect(appCommand).toContain("--allow-legacy-read");
    expect(appCommand.match(/--label(?:=|\s)/g)).toHaveLength(2);

    await Bun.write(join(directory, "settings.json"), JSON.stringify({ defaultProject: "OTHER" }));
    const appContinuation = await executeContinuation(directory, appCommand);
    expect(appContinuation.code, appContinuation.stderr).toBe(0);
    expect(JSON.parse(appContinuation.stdout)).toEqual(expectedApp.slice(2));
    expect(appContinuation.stderr).toBe("");
    expect(existsSync(join(directory, "task-pagination-injected"))).toBe(false);

    await Bun.write(join(directory, "settings.json"), JSON.stringify({}));
    const expectedGlobal = await json(
      "task",
      "list",
      "--all-projects",
      "--label",
      "bug",
      "--label",
      "cli",
      `--column=${specialColumn}`,
      "--due-since=0",
      "--due-until=20",
      "--sort",
      "due",
    );
    const globalPage = await run(
      "task",
      "list",
      "--all-projects",
      ...filters,
      "--json",
    );
    expect(globalPage.code, globalPage.stderr).toBe(0);
    expect(JSON.parse(globalPage.stdout)).toEqual(expectedGlobal.slice(0, 2));
    const globalCommand = extractContinuation(globalPage.stderr);
    expect(globalCommand).toContain("--all-projects");
    expect(globalCommand.match(/--all-projects/g)).toHaveLength(1);

    await Bun.write(join(directory, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
    const globalContinuation = await executeContinuation(directory, globalCommand);
    expect(globalContinuation.code, globalContinuation.stderr).toBe(0);
    expect(JSON.parse(globalContinuation.stdout)).toEqual(expectedGlobal.slice(2));
    expect(globalContinuation.stderr).toBe("");

    const textPage = await run(
      "task",
      "list",
      "APP",
      ...filters,
    );
    expect(textPage.code, textPage.stderr).toBe(0);
    expect(textPage.stderr).toContain("--starting-after");
    expect(textPage.stderr).not.toContain("--json");
    expect(textPage.stdout).toContain(expectedApp[0]!.key);
    expect(textPage.stdout).toContain(expectedApp[1]!.key);
    expect(textPage.stdout).not.toContain(expectedApp[2]!.key);
    expect(existsSync(join(directory, "task-pagination-injected"))).toBe(false);

    for (const sort of [undefined, "activity", "due"] as const) {
      const sortArgs = sort === undefined ? [] : ["--sort", sort];
      const allTasks = await json("task", "list", "APP", ...sortArgs);
      const collected: Array<{ id: string; key: string }> = [];
      let page = await run("task", "list", "APP", ...sortArgs, "--limit", "2", "--json");

      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        expect(page.code, page.stderr).toBe(0);
        collected.push(...(JSON.parse(page.stdout) as Array<{ id: string; key: string }>));
        if (page.stderr.length === 0) {
          break;
        }

        expect(page.stderr).toContain("--starting-after");
        page = await executeContinuation(directory, extractContinuation(page.stderr));
      }

      expect(collected).toEqual(allTasks);
      expect(existsSync(join(directory, "task-pagination-injected"))).toBe(false);
    }
  });
});

test("task list cursor metadata, ID spellings, membership errors and final pages", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const run = async (...args: Array<string>) => runZinn(args, directory);
    const json = async (...args: Array<string>) => {
      const result = await run(...args, "--json");
      expect(result.code, result.stderr).toBe(0);
      return { result, tasks: JSON.parse(result.stdout) as Array<{ id: string; key: string }> };
    };

    const route = parsedRoutes.find(({ command }) => command === "task list")!;
    expect(route.input?.options?.["starting-after"]).toMatchObject({
      type: "string",
      value: { kind: "task-id", name: "id", description: expect.stringContaining("prefix") },
    });
    const help = await run("task", "list", "--help");
    expect(help.code, help.stderr).toBe(0);
    for (const fact of ["--starting-after", "UUID", "prefix", "selection filters", "stderr"]) {
      expect(help.stdout).toContain(fact);
    }

    await run("project", "create", "APP");
    await run("project", "create", "OTHER");
    await run("task", "create", "APP", "--title", "Zero", "--due=0");
    await run("task", "create", "APP", "--title", "Ten", "--due=10");
    await run("task", "create", "APP", "--title", "Twenty", "--due=20");
    await run("task", "create", "APP", "--title", "Thirty", "--due=30");
    await run("task", "create", "APP", "--title", "Outside bounds", "--due=40");
    await run("task", "create", "APP", "--title", "Undated");
    const otherTaskResult = await run("task", "create", "OTHER", "--title", "Outside project", "--json");
    expect(otherTaskResult.code, otherTaskResult.stderr).toBe(0);
    const otherTask = JSON.parse(otherTaskResult.stdout) as { id: string; key: string };
    const snapshot = () =>
      withTestDb(directory, (db) => ({
        task: db.query("SELECT * FROM task ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
    const beforeReads = snapshot();
    const all = await json("task", "list", "APP", "--sort", "due");
    const before = all.tasks;
    expect(all.result.stderr).toBe("");
    expect(before.map(({ key }) => key)).toEqual([
      "APP-1",
      "APP-2",
      "APP-3",
      "APP-4",
      "APP-5",
      "APP-6",
    ]);

    const bounded = await json(
      "task",
      "list",
      "APP",
      "--sort",
      "due",
      "--due-since=0",
      "--due-until=30",
      "--limit=2",
    );
    expect(bounded.tasks.map(({ key }) => key)).toEqual(["APP-1", "APP-2"]);
    expect(bounded.result.stderr).toContain("--starting-after");
    const anchor = bounded.tasks[1]!;
    const continued = await json(
      "task",
      "list",
      "APP",
      "--sort",
      "due",
      "--due-since=0",
      "--due-until=30",
      "--starting-after",
      anchor.id,
      "--limit=2",
    );
    expect(continued.tasks.map(({ key }) => key)).toEqual(["APP-3", "APP-4"]);
    expect(continued.result.stderr).toBe("");

    const replacedCursor = await run(
      "task",
      "list",
      "APP",
      "--starting-after",
      before[0]!.id,
      "--limit=1",
      "--json",
    );
    expect(replacedCursor.code, replacedCursor.stderr).toBe(0);
    const replacementCommand = extractContinuation(replacedCursor.stderr);
    expect(replacementCommand.match(/--starting-after/g)).toHaveLength(1);
    expect(replacementCommand).toContain(before[1]!.id);
    expect(replacementCommand).not.toContain(before[0]!.id);

    const compactUpper = anchor.id.replaceAll("-", "").toUpperCase();
    const compactCursor = await json("task", "list", "APP", "--starting-after", compactUpper, "--sort", "due");
    expect(compactCursor.tasks.map(({ key }) => key)).toEqual(before.slice(2).map(({ key }) => key));
    expect(compactCursor.result.stderr).toBe("");
    const canonicalUpper = await json(
      "task",
      "list",
      "APP",
      "--starting-after",
      anchor.id.toUpperCase(),
      "--sort",
      "due",
    );
    expect(canonicalUpper.tasks.map(({ key }) => key)).toEqual(compactCursor.tasks.map(({ key }) => key));
    expect(canonicalUpper.result.stderr).toBe("");
    const idHex = anchor.id.replaceAll("-", "");
    let prefix: string | undefined;
    for (let length = 8; length < idHex.length; length++) {
      const candidate = idHex.slice(0, length);
      const canonical = canonicalPrefix(anchor.id, length);
      const matches = [...before, otherTask].filter(({ id }) => id.replaceAll("-", "").startsWith(candidate));
      if (matches.length === 1) {
        prefix = canonical;
        break;
      }
    }
    expect(prefix).toBeDefined();
    const prefixCursor = await json("task", "list", "APP", "--starting-after", prefix!, "--sort", "due");
    expect(prefixCursor.tasks.map(({ key }) => key)).toEqual(compactCursor.tasks.map(({ key }) => key));
    expect(prefixCursor.result.stderr).toBe("");
    const beyondFirstPage = await json(
      "task",
      "list",
      "APP",
      "--sort",
      "due",
      "--starting-after",
      before[3]!.id,
      "--limit=1",
    );
    expect(beyondFirstPage.tasks.map(({ key }) => key)).toEqual(["APP-5"]);
    expect(beyondFirstPage.result.stderr).toContain("--starting-after");

    const exactFinal = await json("task", "list", "APP", "--starting-after", before[4]!.id, "--limit=1");
    expect(exactFinal.tasks.map(({ key }) => key)).toEqual(["APP-6"]);
    expect(exactFinal.result.stderr).toBe("");
    const shortFinal = await json("task", "list", "APP", "--starting-after", before[4]!.id, "--limit=2");
    expect(shortFinal.tasks.map(({ key }) => key)).toEqual(["APP-6"]);
    expect(shortFinal.result.stderr).toBe("");
    const emptyFinal = await json("task", "list", "APP", "--starting-after", before[5]!.id, "--limit=1");
    expect(emptyFinal.tasks).toEqual([]);
    expect(emptyFinal.result.stderr).toBe("");
    const cappedAll = await json("task", "list", "APP", "--limit=11871");
    expect(cappedAll.tasks).toHaveLength(before.length);
    expect(cappedAll.result.stderr).toBe("");

    const outOfSelection = await run(
      "task",
      "list",
      "APP",
      "--due-until=30",
      "--starting-after",
      before[4]!.id,
      "--json",
    );
    expect(outOfSelection.code).toBe(1);
    expect(outOfSelection.stdout).toBe("");
    expect(jsonError(outOfSelection.stderr)).toMatchObject({
      code: "invalid_input",
      details: { field: ["startingAfter"] },
    });

    const taskKeyCursor = await run("task", "list", "APP", "--starting-after", "APP-1", "--json");
    expect(taskKeyCursor.code).toBe(1);
    expect(jsonError(taskKeyCursor.stderr).code).toBe("invalid_input");
    const shortPrefix = await run("task", "list", "APP", "--starting-after", "abcdef1", "--json");
    expect(shortPrefix.code).toBe(1);
    expect(jsonError(shortPrefix.stderr)).toMatchObject({
      code: "invalid_input",
      details: { field: ["startingAfter"] },
    });
    const ambiguousPrefix = before[0]!.id.replaceAll("-", "").slice(0, 8);
    expect(before.filter(({ id }) => id.replaceAll("-", "").startsWith(ambiguousPrefix)).length).toBeGreaterThan(1);
    const ambiguous = await run("task", "list", "APP", "--starting-after", ambiguousPrefix, "--json");
    expect(ambiguous.code).toBe(1);
    expect(jsonError(ambiguous.stderr)).toMatchObject({
      code: "conflict",
      details: { reason: "ambiguous_reference" },
    });
    const otherProjectCursor = await run(
      "task",
      "list",
      "APP",
      "--starting-after",
      otherTask.id,
      "--json",
    );
    expect(otherProjectCursor.code).toBe(1);
    expect(jsonError(otherProjectCursor.stderr)).toMatchObject({
      code: "invalid_input",
      details: { field: ["startingAfter"] },
    });
    const missing = await run(
      "task",
      "list",
      "APP",
      "--starting-after",
      "ffffffff-ffff-7fff-8fff-ffffffffffff",
      "--json",
    );
    expect(missing.code).toBe(1);
    expect(jsonError(missing.stderr)).toMatchObject({
      code: "not_found",
      details: { entity: "task" },
    });
    expect(snapshot()).toEqual(beforeReads);

    const deletedResult = await run("task", "create", "APP", "--title", "Deleted", "--json");
    expect(deletedResult.code, deletedResult.stderr).toBe(0);
    const deleted = JSON.parse(deletedResult.stdout) as { id: string; key: string };
    const deleteTask = await run("task", "delete", deleted.key, "--yes");
    expect(deleteTask.code, deleteTask.stderr).toBe(0);
    const deletedCursor = await run(
      "task",
      "list",
      "APP",
      "--starting-after",
      deleted.id,
      "--json",
    );
    expect(deletedCursor.code).toBe(1);
    expect(jsonError(deletedCursor.stderr)).toMatchObject({
      code: "not_found",
      details: { entity: "task" },
    });
  });
});
