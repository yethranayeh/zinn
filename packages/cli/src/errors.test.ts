import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, SqliteError } from "@zinn-dev/core";
import { classifyFailure, errorDocumentSchema } from "./errors";
import { openDatabase } from "../../core/src/sqlite/bun";
import { MIGRATIONS, latestVersion } from "../../core/src/migrations/registry";

const CLI_PATH = new URL("../index.ts", import.meta.url).pathname;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zinn-error-"));
  const databasePath = join(directory, "data/zinn.sqlite");
  const invoke = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
      cwd: directory,
      env: { ...process.env, ZINN_DIR: directory, ZINN_DEBUG: undefined },
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
  for (const [code, reason] of [["EACCES", "permission_denied"], ["EPERM", "permission_denied"], ["EROFS", "read_only"], ["ENOSPC", "disk_full"], ["EIO", "io"]]) {
    const cause = Object.assign(new Error("filesystem operation failed"), { code, path: "/known/path", sql: "secret", bindings: ["secret"] });
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
    `]);
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
