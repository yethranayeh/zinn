import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, SqliteError } from "@zinn-dev/core";
import { CliError, classifyFailure, errorDetailsSchema, errorDocumentSchema } from "./errors";
import { openDatabase } from "../../core/src/sqlite/bun";
import { MIGRATIONS, latestVersion } from "../../core/src/migrations/registry";

const CLI_PATH = new URL("../index.ts", import.meta.url).pathname;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zinn-error-"));
  const databasePath = join(directory, "data/zinn.sqlite");
  const invoke = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
      cwd: directory,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, ZINN_DEBUG: undefined },
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return {
    directory, databasePath, invoke,
    succeed: (...args: string[]) => {
      const result = invoke(...args, "--json");
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    },
    fail: (...args: string[]) => {
      const result = invoke(...args, "--json");
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      return errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("ZINN-283: operational causes survive wrappers; unknown failures and constraints stay internal", () => {
  const cases = [
    [5, "busy"], [6, "locked"], [8, "read_only"], [10, "io"],
    [11, "corrupt"], [13, "disk_full"], [14, "io"], [26, "not_database"],
  ] as const;
  for (const [errcode, reason] of cases) {
    const error = new SqliteError("operation failed", errcode, new Error("driver internals"));
    const result = classifyFailure(new Error("initialization failed", { cause: error }));
    expect(result).toMatchObject({ code: "storage", details: { reason, cause: { code: error.code, errcode } } });
    expect(JSON.stringify(result)).not.toContain("driver internals");
  }
  for (const [code, reason] of [["EACCES", "permission_denied"], ["EPERM", "permission_denied"], ["EROFS", "read_only"], ["ENOSPC", "disk_full"], ["EIO", "io"], ["ENAMETOOLONG", "io"], ["ELOOP", "io"]]) {
    const cause = Object.assign(new Error("filesystem operation failed"), { code, path: "/known/path", sql: "secret", bindings: ["secret"] });
    expect(classifyFailure(cause)).toMatchObject({ code: "storage", details: { reason, path: "/known/path", cause: { code } } });
    const failure = classifyFailure(new CoreError("cannot read settings", "storage", { settingsPath: "/known/settings" }, { cause }));
    expect(failure).toMatchObject({ code: "storage", details: { reason, path: "/known/path", settingsPath: "/known/settings", cause: { code } } });
    expect(JSON.stringify(failure)).not.toContain("secret");
  }
  expect(classifyFailure(new SqliteError("constraint failed", 19, null)).code).toBe("internal");
  expect(classifyFailure(new Error("database is locked"))).toEqual({ code: "internal" });
  const cycle = new Error("unexpected");
  cycle.cause = cycle;
  expect(classifyFailure(cycle)).toEqual({ code: "internal" });
});

test.each([
  { errcode: 517, reason: "busy" },
  { errcode: 779, reason: "corrupt" },
  { errcode: (100 << 8) | 5, reason: "busy" },
  { errcode: (100 << 8) | 11, reason: "corrupt" },
  { errcode: (100 << 8) | 10, reason: "io" },
])("SQLite reason translation preserves family and cause for $errcode", ({ errcode, reason }) => {
  const error = new SqliteError("operation failed", errcode, new Error("driver internals"));
  const result = classifyFailure(new Error("initialization failed", { cause: error }));

  expect(result).toEqual({
    code: "storage",
    details: { reason, cause: { code: error.code, errcode, message: error.message } },
  });
});

test("SQLite reason translation leaves unknown primary codes and shaped errors internal", () => {
  const unknown = new SqliteError("unknown primary code", 255, null);
  const shaped = Object.assign(new Error("shaped corruption error"), { code: "SQLITE_CORRUPT", errcode: 11 });

  expect(classifyFailure(unknown)).toEqual({ code: "internal" });
  expect(classifyFailure(shaped)).toEqual({ code: "internal" });
});

test("ZINN-283: rare injected failures include buffered notices once and never serialize arbitrary error properties", () => {
  const lib = new URL("./lib.ts", import.meta.url).pathname;
  const core = new URL("../../core/index.ts", import.meta.url).pathname;
  for (const expression of [
    "new SqliteError('disk full', 13, new Error('driver internals'))",
    "Object.assign(new Error('permission denied'), { code: 'EACCES', sql: 'secret SQL', bindings: ['secret binding'] })",
    "{ message: { submitted: 'secret input' }, stack: 'secret stack' }",
  ]) {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { prepareOutput, diagnostic, renderFailure } from ${JSON.stringify(lib)};
      import { SqliteError } from ${JSON.stringify(core)};
      prepareOutput(['--json']);
      diagnostic('prior notice');
      renderFailure(${expression});
    `], { env: TEST_ENVIRONMENT });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    const stderr = result.stderr.toString();
    const failure = errorDocumentSchema.parse(JSON.parse(stderr)).error;
    expect(failure.diagnostics).toEqual(["prior notice"]);
    expect(stderr).not.toContain("secret");
    expect(stderr).not.toContain("driver internals");
  }
});

test("ZINN-283: invocation failures expose their argument or field and preserve usage help", () => {
  const f = fixture();
  try {
    const cases = [
      { args: ["unknown"], argument: "command" },
      { args: ["task", "view"], argument: "task-key", help: true },
      { args: ["task", "view", "APP-1", "--bad"], argument: "--bad", help: true },
      { args: ["task", "create", "APP", "--title"], argument: "--title", help: true },
      { args: ["task", "create", "APP"], argument: "--title" },
      { args: ["task", "list", "--json"], argument: "--json" },
      { args: ["task", "list", "--archived", "--all"], argument: "--archived" },
      { args: ["task", "search", "word", "--limit", "zero"], argument: "--limit" },
      { args: ["task", "create", "APP", "--title", "Title", "--priority", "invalid"], argument: "--priority" },
      { args: ["task", "order", "APP-1", "sideways"], argument: "direction", help: true },
    ];
    f.succeed("project", "create", "APP");
    for (const { args, argument, help } of cases) {
      const error = f.fail(...args);
      expect(error.code, args.join(" ")).toBe("invalid_input");
      if (argument !== undefined) {
        expect(error.details?.argument).toBe(argument);
      }
      if (help) {
        expect(error.help).toContain("Usage:");
      }
    }
    expect(f.fail("task", "view", "APP-1", "extra").details?.field).toEqual([]);
    expect(f.fail("label", "create", "bad", "--color", "invalid")).toMatchObject({ code: "invalid_input", details: { field: ["color"] } });
    expect(f.succeed("task", "list", "APP")).toEqual([]);
  } finally {
    f.close();
  }
});

test("ZINN-346: refusal reasons preserve public facts and leave tasks and activity unchanged", () => {
  const f = fixture();
  try {
    f.succeed("project", "create", "APP");
    f.succeed("task", "create", "APP", "--title", "Example");
    const task = f.succeed("task", "view", "APP-1");
    const activity = f.succeed("activity", "list", "--project", "APP");
    const cases = [
      { args: [], details: { argument: "command", reason: "missing_command" } },
      { args: ["task"], details: { argument: "command", reason: "missing_command" } },
      { args: ["task", "comment"], details: { argument: "command", reason: "missing_command" } },
      { args: ["nonsense"], details: { argument: "command", reason: "unknown_command" } },
      { args: ["task", "comment", "nonsense"], details: { argument: "command", reason: "unknown_command" } },
      { args: ["task", "nonsense", "--help"], details: { argument: "command", reason: "unknown_command" } },
      { args: ["task", "view"], details: { argument: "task-key", reason: "missing_argument" } },
      { args: ["task", "create", "APP", "--title"], details: { argument: "--title", reason: "missing_argument" } },
      { args: ["task", "create", "APP"], details: { argument: "--title", reason: "missing_argument" } },
      { args: ["task", "order", "APP-1"], details: { reason: "missing_argument" } },
      { args: ["task", "view", "APP-1", "extra"], details: { field: [], reason: "unexpected_argument" } },
      { args: ["task", "order", "APP-1", "top", "extra"], details: { field: [], reason: "unexpected_argument" } },
      { args: ["task", "edit", "APP-1", "--description", "- bullet"], details: { argument: "--description", reason: "dash_value" } },
      { args: ["task", "edit", "APP-1", "--status", "Review"], details: { argument: "--status", reason: "unknown_option" } },
      { args: ["task", "view", "APP-1", "--bad"], details: { argument: "--bad", reason: "unknown_option" } },
      { args: ["task", "view", "-later"], details: { reason: "unknown_option" } },
      { args: ["project", "column", "edit", "APP", "In", "Progress", "--name", "Working"], details: { field: [], reason: "unquoted_column" } },
      { args: ["task", "move", "APP-1", "In", "Progress"], code: "not_found", details: { entity: "column", key: "Progress", source: "explicit", reason: "unquoted_column" } },
    ];
    for (const { args, code = "invalid_input", details } of cases) {
      expect(f.fail(...args), args.join(" ")).toMatchObject({ code, details });
    }
    for (const args of [
      ["task", "order", "APP-1", "sideways"],
      ["task", "view", "APP-1", "--history", "--history"],
      ["task", "list", "--archived", "--all"],
      ["task", "create", "APP", "--title", ""],
      ["task", "create", "APP", "--title", "Title", "--priority", "invalid"],
    ]) {
      expect(f.fail(...args).details?.reason, args.join(" ")).toBeUndefined();
    }
    expect(f.fail("task", "delete", "APP-1")).toMatchObject({ details: { reason: "confirmation_required" } });
    const literal = f.invoke("task", "view", "--json", "--", "--bad");
    expect(literal.code).toBe(1);
    expect(literal.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(literal.stderr)).error).toMatchObject({
      code: "invalid_input", details: { field: ["taskKey"] },
    });
    for (const args of [[], ["--json", "--help"], ["task", "--json", "--help", "--bad"], ["task", "view", "--json", "--help", "--bad"]]) {
      const result = f.invoke(...args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(f.succeed("task", "view", "APP-1")).toEqual(task);
    expect(f.succeed("activity", "list", "--project", "APP")).toEqual(activity);

    const manifest = f.succeed("capabilities");
    const publicError = manifest.schemas.definitions.ErrorEnvelope.properties.error;
    expect(publicError.properties.details.properties.reason.enum).toEqual(errorDetailsSchema.shape.reason.unwrap().options);
    expect(publicError.properties).not.toHaveProperty("suggestedRoute");
    expect(publicError.properties.details.properties).not.toHaveProperty("suggestedRoute");
  } finally {
    f.close();
  }
});

test("ZINN-346: canonical repair routes survive rendering limits and never enter the public envelope", () => {
  const f = fixture();
  const lib = new URL("./lib.ts", import.meta.url).pathname;
  const errors = new URL("./errors.ts", import.meta.url).pathname;
  const routes = new URL("./routes/routes.ts", import.meta.url).pathname;
  const router = new URL("./routes/router.ts", import.meta.url).pathname;
  const cases = [
    { args: ["task", "new", "APP", "--body", "description"], route: ["task", "create"] },
    { args: ["task", "edit", "APP-1", "--status", "Review"], route: ["task", "move"] },
    { args: ["task", "new", "APP", "--description", "- bullet"], route: ["task", "create"] },
    { args: ["task", "show", "-later"], route: ["task", "view"] },
    { args: ["task", "move", "APP-1", "In", "Progress"], route: ["task", "move"] },
    { args: ["task", "nonsense"], route: ["task"] },
    { args: ["nonsense"], route: [] },
    { args: ["task", "new", "APP", "--description", "- " + "x".repeat(1600)], route: ["task", "create"] },
    { args: ["task", "new", "APP", "--body", "x".repeat(1600)], route: ["task", "create"] },
    { args: ["task", "show", "APP-1", "--bad"], route: null },
    { args: ["task", "view"], route: null },
  ];
  try {
    f.succeed("project", "create", "APP");
    f.succeed("task", "create", "APP", "--title", "Example");
    for (const { args, route } of cases) {
      const result = Bun.spawnSync([process.execPath, "--eval", `
        import { mock } from "bun:test";
        const lib = await import(${JSON.stringify(lib)});
        const { classifyFailure } = await import(${JSON.stringify(errors)});
        const render = lib.renderFailure;
        mock.module(${JSON.stringify(lib)}, () => ({ ...lib, renderFailure(error) {
          console.log(JSON.stringify(classifyFailure(error).suggestedRoute ?? null));
          render(error);
        } }));
        const { parsedRoutes } = await import(${JSON.stringify(routes)});
        const { createRouter } = await import(${JSON.stringify(router)});
        await createRouter(parsedRoutes).route(${JSON.stringify([...args, "--json"])});
      `], { cwd: f.directory, env: { ...TEST_ENVIRONMENT, ZINN_DIR: f.directory } });
      expect(result.exitCode, result.stderr.toString()).toBe(1);
      expect(JSON.parse(result.stdout.toString()), args.join(" ")).toEqual(route);
      const failure = errorDocumentSchema.parse(JSON.parse(result.stderr.toString())).error;
      expect(failure.message.length).toBeLessThanOrEqual(1024);
    }
  } finally {
    f.close();
  }
});

test("internal recovery routes survive wrappers and reuse the recovery classifications", () => {
  const error = new CliError("repair", "invalid_input", { reason: "unknown_option" }, undefined, ["task", "move"]);
  expect(classifyFailure(new Error("outer", { cause: error }))).toMatchObject({
    code: "invalid_input", details: { reason: "unknown_option" }, suggestedRoute: ["task", "move"],
  });
  expect(classifyFailure(new CoreError("empty", "conflict", { reason: "no_columns", key: "APP" }))).toMatchObject({
    code: "conflict", details: { reason: "no_columns" }, suggestedRoute: ["project", "column", "create"],
  });
  expect(classifyFailure(new CoreError("occupied", "conflict", { reason: "has_tasks" }))).not.toHaveProperty("suggestedRoute");
});

test("label validation prints plain messages and preserves JSON error facts without writes", () => {
  const f = fixture();
  try {
    f.succeed("label", "create", "bug", "--description", "Kept", "--color", "red");
    const labels = f.succeed("label", "list");
    const activities = f.succeed("activity", "list");
    const cases = [
      { args: ["label", "create", "other", "--color", "purple"], field: ["color"], facts: [/red/, /blue/] },
      { args: ["label", "create", " "], field: ["name"], facts: [/label/i, /name/i] },
      { args: ["label", "create", " ", "--color", "purple"], field: ["name"], facts: [/name/i, /red/, /blue/] },
      { args: ["label", "edit", "bug", "--color", "purple"], field: ["color"], facts: [/red/, /blue/] },
      { args: ["label", "edit", "bug", "--name", " "], field: ["name"], facts: [/label/i, /name/i] },
      { args: ["label", "edit", " ", "--color", "red"], field: ["labelName"], facts: [/label/i, /name/i] },
      { args: ["label", "edit", "bug", "--description", "", "--append"], field: ["description", "append"], facts: [/append/i] },
      { args: ["label", "delete", " ", "--yes"], field: ["name"], facts: [/label/i, /name/i] },
    ];
    for (const { args, field, facts } of cases) {
      const text = f.invoke(...args);
      expect(text.code, args.join(" ")).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr.trim()).not.toStartWith("[");
      for (const fact of facts) {
        expect(text.stderr).toMatch(fact);
      }

      const error = f.fail(...args);
      expect(error).toMatchObject({ code: "invalid_input", details: { field } });
      expect(error.message).toBe(text.stderr.trim());
    }
    expect(f.succeed("label", "list")).toEqual(labels);
    expect(f.succeed("activity", "list")).toEqual(activities);
  } finally {
    f.close();
  }
});

test("ZINN-283: missing references, conflicts and text matching keep useful facts and change nothing", () => {
  const f = fixture();
  try {
    f.succeed("project", "create", "APP");
    f.succeed("task", "create", "APP", "--title", "Kept", "--description", "word word");
    expect(f.fail("task", "view", "APP-99")).toMatchObject({ code: "not_found", details: { entity: "task", key: "APP-99", source: "explicit" } });
    expect(f.fail("project", "view", "MISSING")).toMatchObject({ code: "not_found", details: { entity: "project", key: "MISSING" } });
    expect(f.fail("label", "delete", "missing", "--yes")).toMatchObject({ code: "not_found", details: { entity: "label", key: "missing" } });
    expect(f.fail("project", "create", "APP")).toMatchObject({ code: "conflict", details: { reason: "already_exists", entity: "project" } });
    for (const [find, matchCount] of [["absent", 0], ["word", 2]] as const) {
      expect(f.fail("task", "edit", "APP-1", "--description", "replacement", "--replacing", find)).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount, field: ["description"] } });
    }
    expect(f.fail("task", "delete", "APP-1")).toMatchObject({ code: "invalid_input", details: { reason: "confirmation_required", argument: "--yes" } });
    expect(f.succeed("task", "view", "APP-1")).toMatchObject({ title: "Kept", description: "word word" });
    f.succeed("task", "archive", "APP-1");
    expect(f.fail("task", "move", "APP-1", "Done")).toMatchObject({ code: "conflict", details: { reason: "archived", key: "APP-1" } });
    const unchanged = f.invoke("task", "archive", "APP-1", "--json");
    expect(unchanged.code).toBe(0);
    expect(JSON.parse(unchanged.stdout).changed).toBe(false);
    expect(unchanged.stderr).toContain("APP-1");
    const db = new Database(f.databasePath);
    // Give every event a shared prefix independently of UUID timestamps.
    db.exec("UPDATE activity SET id = printf('11111111-1111-7111-8111-%012x', rowid)");
    db.close();
    const events = f.succeed("activity", "list");
    const prefix = events[0].id.replaceAll("-", "").slice(0, 8);
    expect(f.fail("activity", "view", prefix)).toMatchObject({ code: "conflict", details: { reason: "ambiguous_reference", matchCount: events.length, candidateIds: expect.any(Array) } });
  } finally {
    f.close();
  }
});

test("ZINN-283: settings errors and missing configured defaults name the selected file", () => {
  const f = fixture();
  const settingsPath = join(f.directory, "settings.json");
  try {
    f.succeed("project", "create", "APP");
    writeFileSync(settingsPath, JSON.stringify({ defaultProject: "MISSING" }));
    expect(f.fail("project", "view")).toMatchObject({ code: "not_found", details: { entity: "project", key: "MISSING", settingsPath, source: "defaultProject" } });
    writeFileSync(settingsPath, JSON.stringify({ defaultProject: 42 }));
    expect(f.fail("task", "list")).toMatchObject({ code: "invalid_input", details: { settingsPath, field: ["defaultProject"], reason: "invalid_settings" } });
    writeFileSync(settingsPath, "{");
    expect(f.fail("task", "list")).toMatchObject({ code: "invalid_input", details: { settingsPath, reason: "invalid_json" } });
    rmSync(settingsPath);
    mkdirSync(settingsPath);
    expect(f.fail("task", "list")).toMatchObject({ code: "storage", details: { settingsPath, reason: "io", cause: { code: "EISDIR" } } });
  } finally {
    f.close();
  }
});

test("ZINN-283: actual SQLite missing-index rollback and unmarked read notices form one error document", () => {
  const f = fixture();
  try {
    f.succeed("project", "create", "APP");
    f.succeed("task", "create", "APP", "--title", "Kept");
    const db = new Database(f.databasePath);
    db.exec("DROP TABLE task_search");
    db.close();
    const failure = f.fail("task", "edit", "APP-1", "--title", "Lost");
    expect(failure).toMatchObject({ code: "storage", details: { reason: "missing_index", cause: { code: "SQLITE_ERROR", errcode: 1 } } });
    expect(failure.message).toContain("zinn reindex");
    expect(f.succeed("task", "view", "APP-1").title).toBe("Kept");
    const unmarked = new Database(f.databasePath);
    unmarked.exec("PRAGMA user_version = 0");
    unmarked.close();
    const warned = f.fail("task", "search", "word", "--allow-legacy-read");
    expect(warned.code).toBe("storage");
    expect(warned.diagnostics).toHaveLength(1);
    expect(warned.diagnostics?.[0]).toContain("zinn.sqlite");
    const success = f.invoke("task", "view", "APP-1", "--allow-legacy-read", "--json");
    expect(success.code).toBe(0);
    expect(JSON.parse(success.stdout).title).toBe("Kept");
    expect(success.stderr).toContain("zinn.sqlite");
  } finally {
    f.close();
  }
});

test("ZINN-283: actual SQLite busy errors are storage and programming SQL failures are internal", () => {
  const f = fixture();
  let db: ReturnType<typeof openDatabase> | undefined;
  let contender: ReturnType<typeof openDatabase> | undefined;
  try {
    f.succeed("project", "create", "APP");
    db = openDatabase(f.databasePath);
    contender = openDatabase(f.databasePath);
    contender.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    try {
      contender.exec("BEGIN IMMEDIATE");
      throw new Error("Expected a real SQLite lock refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SqliteError);
      expect(classifyFailure(error)).toMatchObject({ code: "storage", details: { reason: "busy", cause: { code: "SQLITE_BUSY", errcode: 5 } } });
    }
    db.exec("ROLLBACK");
    try {
      contender.exec("SELECT * FROM absent_programming_table");
    } catch (error) {
      expect(classifyFailure(error).code).toBe("internal");
    }
  } finally {
    contender?.close();
    db?.close();
    f.close();
  }
});

test("ZINN-283: absent and incompatible administrative inputs preserve paths and versions", () => {
  const f = fixture();
  try {
    expect(f.fail("backup")).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: expect.any(String) } });
    const missingBackup = join(f.directory, "absent.sqlite");
    expect(f.fail("restore", missingBackup, "--yes")).toMatchObject({ code: "not_found", details: { entity: "backup", backupPath: missingBackup } });
    f.succeed("project", "create", "APP");
    const currentVersion = latestVersion(MIGRATIONS);
    const db = new Database(f.databasePath);
    db.exec(`PRAGMA user_version = ${currentVersion + 1}`);
    db.close();
    expect(f.fail("project", "create", "REFUSED")).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: currentVersion + 1, supportedSchemaVersion: currentVersion } });
    expect(f.fail("migrate")).toMatchObject({ code: "conflict", details: { reason: "newer_database" } });
    const corrupt = join(f.directory, "not-sqlite");
    writeFileSync(corrupt, "not SQLite");
    expect(f.fail("restore", corrupt, "--yes")).toMatchObject({ code: "storage", details: { reason: "not_database", cause: { code: "SQLITE_NOTADB", errcode: 26 } } });
  } finally {
    f.close();
  }
});
