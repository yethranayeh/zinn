import { expect, test } from "bun:test";
import { MAX_LIST_LIMIT } from "@zinn-dev/core";
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

function continuationCursor(stderr: string) {
  const command = extractContinuation(stderr);
  const cursor = command.match(/--starting-after (\S+)/)?.[1];
  expect(cursor).toBeDefined();
  return cursor!;
}

test("task list cursor metadata, final pages, changed anchors and cursor refusals", async () => {
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
      value: { kind: "task-cursor", name: "cursor" },
    });
    const help = await run("task", "list", "--help");
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("--starting-after <cursor>");

    await run("project", "create", "APP");
    for (const [title, due] of [["Zero", "0"], ["Ten", "10"], ["Twenty", "20"], ["Thirty", "30"], ["Forty", "40"]]) {
      await run("task", "create", "APP", "--title", title!, `--due=${due}`);
    }
    await run("task", "create", "APP", "--title", "Undated");
    const snapshot = () =>
      withTestDb(directory, (db) => ({
        task: db.query("SELECT * FROM task ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));
    const beforeReads = snapshot();
    const all = await json("task", "list", "APP", "--sort", "due");
    const before = all.tasks;
    expect(all.result.stderr).toBe("");

    const bounded = await json("task", "list", "APP", "--sort", "due", "--due-since=0", "--due-until=30", "--limit=2");
    expect(bounded.tasks.map(({ key }) => key)).toEqual(["APP-1", "APP-2"]);
    const boundedCursor = continuationCursor(bounded.result.stderr);
    expect(boundedCursor.startsWith("-")).toBe(false);
    const continued = await json(
      "task", "list", "APP", "--sort", "due", "--due-since=0", "--due-until=30",
      "--starting-after", boundedCursor, "--limit=2",
    );
    expect(continued.tasks.map(({ key }) => key)).toEqual(["APP-3", "APP-4"]);
    expect(continued.result.stderr).toBe("");

    const boardPage = await json("task", "list", "APP", "--limit=1");
    const boardCursor = continuationCursor(boardPage.result.stderr);
    const replacedCursor = await run("task", "list", "APP", "--starting-after", boardCursor, "--limit=1", "--json");
    expect(replacedCursor.code, replacedCursor.stderr).toBe(0);
    const replacementCommand = extractContinuation(replacedCursor.stderr);
    expect(replacementCommand.match(/--starting-after/g)).toHaveLength(1);
    expect(replacementCommand).not.toContain(boardCursor);

    const beforeLast = await json("task", "list", "APP", `--limit=${before.length - 1}`);
    const lastCursor = continuationCursor(beforeLast.result.stderr);
    const exactFinal = await json("task", "list", "APP", "--starting-after", lastCursor, "--limit=1");
    expect(exactFinal.tasks.map(({ key }) => key)).toEqual(["APP-6"]);
    expect(exactFinal.result.stderr).toBe("");
    const shortFinal = await json("task", "list", "APP", "--starting-after", lastCursor, "--limit=2");
    expect(shortFinal.tasks.map(({ key }) => key)).toEqual(["APP-6"]);
    expect(shortFinal.result.stderr).toBe("");
    const cappedAll = await json("task", "list", "APP", `--limit=${MAX_LIST_LIMIT}`);
    expect(cappedAll.tasks).toHaveLength(before.length);
    expect(cappedAll.result.stderr).toBe("");

    // A cursor stays valid under changed filters with the same sort.
    const changedFilters = await json("task", "list", "APP", "--due-since=10", "--starting-after", boardCursor);
    expect(changedFilters.tasks.map(({ key }) => key)).toEqual(["APP-2", "APP-3", "APP-4", "APP-5"]);

    const refusals: Array<[string, Array<string>]> = [
      ["invalid_cursor", ["--starting-after", "APP-1"]],
      ["invalid_cursor", ["--starting-after", `${boardCursor}*`]],
      ["cursor_version", ["--starting-after", boardCursor.replace(/^(\D+)\d+/, "$19")]],
      ["different_sort", ["--sort", "activity", "--starting-after", boardCursor]],
      ["task_id_cursor", ["--starting-after", before[0]!.id]],
    ];
    for (const [reason, args] of refusals) {
      const result = await run("task", "list", "APP", ...args, "--json");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const error = jsonError(result.stderr) as { code: string; message: string; details?: Record<string, unknown> };
      expect(error).toMatchObject({ code: "invalid_input", details: { field: ["startingAfter"], reason } });
      expect(error.message).toContain("zinn task list");
      const text = await run("task", "list", "APP", ...args);
      expect(text.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("zinn task list");
    }
    expect(snapshot()).toEqual(beforeReads);

    // The anchor task can be deleted between pages.
    const firstPage = await run("task", "list", "APP", "--limit=1");
    expect(firstPage.code, firstPage.stderr).toBe(0);
    const deleteTask = await run("task", "delete", "APP-1", "--yes");
    expect(deleteTask.code, deleteTask.stderr).toBe(0);
    const afterDeleted = await executeContinuation(directory, extractContinuation(firstPage.stderr));
    expect(afterDeleted.code, afterDeleted.stderr).toBe(0);
    expect(afterDeleted.stdout).toContain("APP-2");
    expect(afterDeleted.stdout).not.toContain("APP-1 ");
  });
});
