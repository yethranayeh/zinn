import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import packageJson from "./package.json";
import { CLI_PATH, createDatabase, databaseSnapshot, runProcessAsync, runZinn, runZinnAs, runZinnWithPipedYes, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "./test-helpers";
import { errorDocumentSchema } from "./src/errors";
import type { Activity } from "@zinn-dev/core";
import { latestVersion, MIGRATIONS } from "../core/src/migrations/registry";
import { MAX_TEXT_BYTES } from "@zinn-dev/core";

// ? End-to-end tests: each case spawns the real bin, so `ZINN_DIR` is passed
// ? per-spawn rather than set on `process.env`. Nothing in this process opens a
// ? database.

const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);

// --- ACTIVITY ACTOR

function lastActor(testDir: string) {
  return withTestDb(testDir, (db) =>
    db.query<{ action: string; actor_name: string | null; actor_email: string | null; actor_kind: string; actor_source: string | null }, []>(
      "SELECT action, actor_name, actor_email, actor_kind, actor_source FROM activity ORDER BY id DESC LIMIT 1",
    ).get(),
  );
}

test("mutations record the invoking agent, then the git identity, then the OS user", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const identityFile = join(dir, "gitconfig");
    writeFileSync(identityFile, "[user]\n\tname = Git Person\n\temail = git@example.com\n");

    expect((await runZinnAs(["project", "create", "ACT"], dir, { AI_AGENT: "project-agent" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "project-agent", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });
    expect((await runZinnAs(["task", "create", "ACT", "--title", "Tracked"], dir, { AI_AGENT: "test-agent_1-0" })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "create", actor_name: "test-agent_1-0", actor_email: null, actor_kind: "agent", actor_source: "env:AI_AGENT" });

    expect((await runZinnAs(["task", "move", "ACT-1", "TODO"], dir, { GIT_CONFIG_GLOBAL: identityFile })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "move", actor_name: "Git Person", actor_email: "git@example.com", actor_kind: "human", actor_source: "git-config" });

    expect((await runZinnAs(["task", "archive", "ACT-1"], dir, { GIT_CONFIG_GLOBAL: "/dev/null", USER: userInfo().username })).code).toBe(0);
    expect(lastActor(dir)).toEqual({ action: "archive", actor_name: userInfo().username, actor_email: null, actor_kind: "human", actor_source: "os-user" });
  });
});

test("CLI mutations preserve declared identity pairs and metadata without recording no-ops or failures", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const declared = {
      AI_AGENT: "integration-client", ZINN_SESSION_ID: " conversation ", ZINN_THREAD_ID: " child ",
      ZINN_AGENT: " Explore ", ZINN_MODEL: " provider/model ", ZINN_EFFORT: " 0.7 ",
      CLAUDE_CODE_SESSION_ID: "native-session", CODEX_SESSION_ID: "codex-session", CODEX_THREAD_ID: "codex-thread",
    };
    const events = async (): Promise<Array<Activity>> => JSON.parse((await runZinn(["activity", "list", "--json"], directory)).stdout);
    expect((await runZinnAs(["project", "create", "IDENTITY"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "create", "IDENTITY", "--title", "Tracked"], directory, declared)).code).toBe(0);
    const item = (await events())[0]!;
    expect(item).toMatchObject({
      actor_name: "integration-client", actor_kind: "agent", actor_source: "env:AI_AGENT",
      actor_session_id: "conversation", actor_thread_id: "child", actor_agent: "Explore",
      actor_model: "provider/model", actor_effort: "0.7",
    });
    const before = await events();
    expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", "Tracked"], directory, declared)).code).toBe(0);
    expect((await runZinnAs(["task", "move", "IDENTITY-1", "Missing"], directory, declared)).code).toBe(1);
    expect(await events()).toEqual(before);

    const cases: Array<{ env: Record<string, string>; name: string | null; session: string | null; thread: string | null }> = [
      { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-root", CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread" }, name: "claude-code", session: "claude-root", thread: null },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-root" }, name: "codex", session: "codex-root", thread: "codex-root" },
      { env: { CODEX_SESSION_ID: "codex-root", CODEX_THREAD_ID: "codex-child" }, name: "codex", session: "codex-root", thread: "codex-child" },
      { env: { CODEX_SESSION_ID: "outer-root", CODEX_THREAD_ID: "outer-thread", ZINN_THREAD_ID: "explicit-child" }, name: "codex", session: null, thread: "explicit-child" },
      { env: { AGENT: "1", OPENCODE: "1" }, name: "opencode", session: null, thread: null },
      { env: { AGENT: "1" }, name: null, session: null, thread: null },
    ];
    for (const [index, entry] of cases.entries()) {
      expect((await runZinnAs(["task", "edit", "IDENTITY-1", "--title", `Change ${index}`], directory, entry.env)).code).toBe(0);
      expect((await events())[0]).toMatchObject({
        actor_name: entry.name, actor_kind: "agent", actor_session_id: entry.session, actor_thread_id: entry.thread,
        actor_agent: null, actor_model: null, actor_effort: null,
      });
    }
    const unnamed = (await events())[0]!;
    expect(unnamed.actor_source).toBe("env:AGENT");
    expect((await runZinn(["activity", "list", "--limit", "1"], directory)).stdout).toContain("unknown (agent)");
    const view = await runZinn(["activity", "view", unnamed.id], directory);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("unknown");
    expect(JSON.parse((await runZinn(["activity", "view", unnamed.id, "--json"], directory)).stdout).actor_name).toBeNull();
  });
});

// --- REINDEX (ZINN-49)

test("reindex rebuilds a missing search index from the tasks and comments, archived ones included", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Gadget export"], dir);
    await runZinn(["task", "comment", "create", "IDX-1", "--text", "Needs a spinner"], dir);
    await runZinn(["task", "archive", "IDX-2"], dir);
    const before = databaseSnapshot(dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));

    expect((await runZinn(["task", "search", "spinner"], dir)).code).toBe(1);

    const result = await runZinn(["reindex", "--json"], dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      databasePath: join(realpathSync(dir), "data", "zinn.sqlite"),
      taskCount: 2,
    });
    expect((await runZinn(["task", "search", "spinner"], dir)).stdout).toContain("IDX-1");
    expect((await runZinn(["task", "search", "gadget", "--archived"], dir)).stdout).toContain("IDX-2");
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    expect((await runZinn(["reindex"], dir)).stdout).toContain("2");
  });
});

test("a missing search index points search and index-updating writes at reindex, changing nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    await runZinn(["task", "create", "IDX", "--title", "Widget login"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_search"));
    const countRows = () =>
      withTestDb(dir, (db) =>
        db.query("SELECT (SELECT COUNT(*) FROM comment) AS comments, (SELECT COUNT(*) FROM activity) AS activities").get(),
      );
    const before = { snapshot: databaseSnapshot(dir), rows: countRows() };

    for (const args of [
      ["task", "search", "widget"],
      ["task", "create", "IDX", "--title", "Refused"],
      ["task", "comment", "create", "IDX-1", "--text", "Refused"],
    ]) {
      const plain = await runZinn(args, dir);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("task_search");
      expect(plain.stderr).toContain("zinn reindex");

      const json = await runZinn([...args, "--json"], dir);
      expect(json.code).toBe(1);
      expect(json.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(json.stderr)).error).toMatchObject({ code: "storage", details: { reason: "missing_index" } });
      expect(JSON.parse(json.stderr).error.message).toContain("task_search");
      expect(JSON.parse(json.stderr).error.message).toContain("zinn reindex");
    }
    expect({ snapshot: databaseSnapshot(dir), rows: countRows() }).toEqual(before);
  });
});

test("a missing table other than the search index gets no reindex hint", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "IDX"], dir);
    withTestDb(dir, (db) => db.run("DROP TABLE task_label; DROP TABLE label"));
    const result = await runZinn(["label", "list"], dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("label");
    expect(result.stderr).not.toContain("reindex");
  });
});

test("reindex refuses when there is no database and creates only telemetry", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database", databasePath: join(dir, "data", "zinn.sqlite") } });
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
  });
});

test("reindex refuses an empty database file and leaves it empty", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const databasePath = join(dir, "data", "zinn.sqlite");
    mkdirSync(dirname(databasePath));
    writeFileSync(databasePath, "");
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { databasePath } });
    expect(readdirSync(dirname(databasePath))).toEqual(["zinn.sqlite"]);
    expect(readFileSync(databasePath).length).toBe(0);
  });
});

test("reindex refuses a newer database and leaves it unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "reindex"], dir);

    expect(result.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", schemaVersion: 9 } });

    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

// --- READ-ONLY DATABASES (ZINN-118)

test("a newer database refuses changes, naming both versions and this CLI, while reads still work", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);

    const list = await runZinn(["task", "list", "MIG"], dir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Kept");

    const created = await runZinn(["--json", "task", "create", "MIG", "--title", "Refused"], dir);
    expect(created.code).toBe(1);
    expect(created.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(created.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database", databasePath: join(dir, "data", "zinn.sqlite"), schemaVersion: 9, supportedSchemaVersion: CURRENT_SCHEMA_VERSION } });

    for (const fact of ["cli", packageJson.version, CLI_PATH]) {
      expect(JSON.parse(created.stderr).error.message).toContain(fact);
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("task delete on a read-only database refuses before asking for confirmation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 9);
    const before = databaseSnapshot(dir);
    const result = await runZinnWithPipedYes(["--json", "task", "delete", "MIG-1"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "newer_database" } });
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("an unmarked database is refused, for reads and writes, and left unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    for (const args of [["task", "list", "MIG"], ["task", "create", "MIG", "--title", "Refused"]]) {
      const result = await runZinn(["--json", ...args], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0, databasePath: join(dir, "data", "zinn.sqlite") } });
    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

// --- LEGACY READS (ZINN-119)

const LEGACY_FLAG = "--allow-legacy-read";

function warningLines(stderr: string, databasePath: string) {
  return stderr.split("\n").filter((line) => line.includes(databasePath));
}

test("--allow-legacy-read reads an unmarked database with one warning on stderr, each invocation needing it again", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const databasePath = join(dir, "data", "zinn.sqlite");

    for (const args of [["task", "list", "MIG", LEGACY_FLAG], [LEGACY_FLAG, "project", "list"], ["task", "view", "MIG-1", LEGACY_FLAG]]) {
      const allowed = await runZinn(args, dir);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain("MIG");
      expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);
      expect(allowed.stderr).toContain(databasePath);
    }

    const refused = await runZinn(["task", "list", "MIG"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(LEGACY_FLAG);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read with --json keeps stdout parseable and refusals as a JSON error", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);

    const allowed = await runZinn(["task", "list", "MIG", "--json", LEGACY_FLAG], dir);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toHaveLength(1);
    expect(warningLines(allowed.stderr, join(dir, "data", "zinn.sqlite"))).toHaveLength(1);

    const refused = await runZinn(["task", "list", "MIG", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr).error.message).toContain(LEGACY_FLAG);
  });
});

test("a --allow-legacy-read after -- is command input, so the database stays refused", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const result = await runZinn(["--json", "task", "search", "--", LEGACY_FLAG], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database" } });
    expect(result.stderr).not.toContain("Warning:");
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("--allow-legacy-read never lets a command change an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    const attempts = [
      ["task", "create", "MIG", "--title", "Refused"],
      ["task", "edit", "MIG-1", "--title", "Refused"],
      ["task", "delete", "MIG-1", "--yes"],
      ["project", "create", "NEW"],
    ];

    for (const args of attempts) {
      const result = await runZinn(["--json", ...args, LEGACY_FLAG], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "unmarked_database", schemaVersion: 0 } });

    }
    expect(databaseSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

test("--allow-legacy-read does not warn about a database that has a schema version", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, CURRENT_SCHEMA_VERSION);
    const current = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(current.code).toBe(0);
    expect(current.stderr).toBe("");

    withTestDb(dir, (db) => db.run("PRAGMA user_version = 9"));
    const newer = await runZinn(["task", "list", "MIG", LEGACY_FLAG], dir);
    expect(newer.code).toBe(0);
    expect(newer.stderr).toBe("");
  });
});

test("help, --version and backup need no --allow-legacy-read for an unmarked database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);

    expect((await runZinn(["--help"], dir)).stdout).toContain(LEGACY_FLAG);
    expect((await runZinn(["--version"], dir)).code).toBe(0);

    const backup = await runZinn(["backup", "--json"], dir);
    expect(backup.code).toBe(0);
    expect(backup.stderr).toBe("");
    expect(existsSync(JSON.parse(backup.stdout).path)).toBe(true);
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("help and --version open no database, not even one that core refuses", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const commands = [["--version"], ["--help"], ["task", "--help"], ["task", "create", "--help"]];

    for (const args of commands) {
      expect((await runZinn(args, dir)).code).toBe(0);
    }
    expect(withoutTelemetry(readdirSync(dir))).toEqual([]);

    await createDatabase(dir, 0);
    const before = databaseSnapshot(dir);
    for (const args of commands) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(databaseSnapshot(dir)).toEqual(before);
  });
});

test("simultaneous backup commands create distinct valid snapshots", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BAK"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BAK", "--title", "Saved"], dir)).code).toBe(0);

    const results = await Promise.all(Array.from({ length: 4 }, () => runZinn(["backup", "--json"], dir, { AI_AGENT: "concurrency-test" })));
    const paths = new Set<string>();
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const { path } = JSON.parse(result.stdout) as { path: string };
      expect(paths.has(path)).toBe(false);
      paths.add(path);
      const snapshot = new Database(path, { readonly: true });
      try {
        expect(snapshot.query("SELECT title FROM task").all()).toEqual([{ title: "Saved" }]);
        expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    }
  });
});

test.each([
  { type: "project", create: ["EMPTY"], editKey: "EMPTY", read: ["project", "view", "EMPTY"], omitted: ["OMITTED"] },
  { type: "task", create: ["APP", "--title", "Empty"], editKey: "APP-1", read: ["task", "view", "APP-1"], omitted: ["APP", "--title", "Omitted"] },
  { type: "label", create: ["empty"], editKey: "empty", read: ["label", "list"], omitted: ["omitted"] },
])("$type descriptions normalize blank input and preserve meaningful formatting", async (entity) => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    if (entity.type === "task") {
      expect((await run("project", "create", "APP")).code).toBe(0);
    }
    const created = await run(entity.type, "create", ...entity.create, "--description", " \n\t ", "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).description).toBeNull();
    for (const clearInput of ["", " \n\t "]) {
      const description = "  Details\n\tIndented  \n";
      const edited = await run(entity.type, "edit", entity.editKey, "--description", description, "--json");
      expect(edited.code).toBe(0);
      expect(JSON.parse(edited.stdout).description).toBe(description);
      const cleared = await run(entity.type, "edit", entity.editKey, "--description", clearInput, "--json");
      expect(cleared.code).toBe(0);
      expect(JSON.parse(cleared.stdout).description).toBeNull();
    }
    const result = JSON.parse((await run(...entity.read, "--json")).stdout);
    expect((Array.isArray(result) ? result[0] : result).description).toBeNull();
    expect(JSON.parse((await run(entity.type, "create", ...entity.omitted, "--json")).stdout).description).toBeNull();
  });
});

test("project descriptions flow through creation, partial edits, view, list and clearing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "Purpose\nMore context";
    const created = await run("project", "create", "DESC", "--description", description, "--json");
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "DESC", description });
    expect((await run("project", "view", "DESC")).stdout).toStartWith(`DESC | DESC\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "list")).stdout).toBe("DESC | DESC | 0 active | 0 archived | Purpose More context\n");
    expect(JSON.parse((await run("project", "list", "--json")).stdout)[0].description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--name", "Renamed", "--json")).stdout).description).toBe(description);
    expect(JSON.parse((await run("project", "edit", "DESC", "--description", "Updated", "--json")).stdout)).toEqual({ id: expect.any(String), key: "DESC", name: "Renamed", description: "Updated", changed: true });
    expect((await run("project", "edit", "DESC", "--description", "")).stdout).toBe("DESC | Renamed\n");
    expect(JSON.parse((await run("project", "view", "DESC", "--json")).stdout).description).toBeNull();
    expect((await run("project", "edit", "DESC", "--description", "a", "--description", "b")).code).toBe(1);
  });
});

test("project list and write rows show truncated description previews, project view and JSON keep full text, and task rows leave descriptions out", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = (...args: string[]) => runZinn(args, dir);
    const description = "  Context\n" + "x".repeat(200);
    const preview = `Context ${"x".repeat(71)}…`;
    expect(preview).toHaveLength(80);
    const taskProject = JSON.parse((await run("project", "create", "PRE", "--description", description, "--json")).stdout);
    await run("task", "create", "PRE", "--title", "Task", "--description", description);
    expect((await run("task", "list", "PRE")).stdout).toBe("PRE-1 | Backlog | - | Task\n");
    expect((await run("project", "list")).stdout).toBe(`PRE | PRE | 1 active | 0 archived | ${preview}\n`);
    expect((await run("project", "view", "PRE")).stdout).toStartWith(`PRE | PRE\n\nDescription:\n${description}\n\nColumns:\n`);
    expect((await run("project", "edit", "PRE", "--description", description)).stdout).toBe(`PRE | PRE | ${preview}\n`);
    expect(taskProject.description).toBe(description);
    expect(JSON.parse((await run("project", "view", "PRE", "--json")).stdout).description).toBe(description);
    expect((await run("project", "edit", "PRE", "--description", " \n ")).stdout).toBe("PRE | PRE\n");
  });
});

// --- CONCURRENCY (ZINN-68)

test("concurrent fresh initialization supports readers and project creators", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (let round = 0; round < 3; round++) {
      const store = join(dir, `list-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, () =>
        runZinn(["project", "list", "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // ZINN-458: readers of a store without a database report it and create nothing.
      for (const result of results) {
        expect(result.code).toBe(1);
        expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
      }
      expect(withoutTelemetry(readdirSync(store))).toEqual([]);
    }

    for (let round = 0; round < 3; round++) {
      const store = join(dir, `mixed-${round}`);
      mkdirSync(store);
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        runZinn(index % 2 === 0
          ? ["project", "list", "--json"]
          : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
      ));

      // A reader that loses the race with the creating writer reports the missing database.
      for (const [index, result] of results.entries()) {
        if (index % 2 === 1 || result.code === 0) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        } else {
          expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "database" } });
        }
      }
      withTestDb(store, (db) => {
        expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: 20 });
        expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      });
    }

    for (const operation of ["create"]) {
      for (let round = 0; round < 3; round++) {
        const store = join(dir, `${operation}-${round}`);
        mkdirSync(store);
        const results = await Promise.all(Array.from({ length: 40 }, (_, index) =>
          runZinn(operation === "list"
            ? ["project", "list", "--json"]
            : ["project", "create", `P${index}`, "--json"], store, { AI_AGENT: "concurrency-test" }),
        ));

        for (const result of results) {
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        }
        withTestDb(store, (db) => {
          const expectedProjects = operation === "create" ? 40 : 0;
          expect(db.query("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: expectedProjects });
          expect(db.query("SELECT COUNT(*) AS count FROM project_column").get()).toEqual({ count: expectedProjects * 5 });
          expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: expectedProjects });
          expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        });
      }
    }
  });
}, 60_000);

test("concurrent task and comment writes preserve results, counters, order, activity and search", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "BEN"], dir)).code).toBe(0);
    expect((await runZinn(["task", "create", "BEN", "--title", "comment-target"], dir)).code).toBe(0);
    const taskKeys = ["BEN-1"];
    const commentKeys: Array<string> = [];
    const titles = ["comment-target"];
    const comments: Array<string> = [];

    for (let round = 0; round < 3; round++) {
      const operations = [
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "task", token: `task${round}n${index}` })),
        ...Array.from({ length: 40 }, (_, index) => ({ kind: "comment", token: `comment${round}n${index}` })),
        ...Array.from({ length: 20 }, () => ({ kind: "read", token: "" })),
      ];
      const results = await Promise.all(operations.map(async ({ kind, token }) => {
        const args = kind === "task" ? ["task", "create", "BEN", "--title", token, "--json"]
          : kind === "comment" ? ["task", "comment", "create", "BEN-1", "--text", token, "--json"]
          : ["task", "list", "BEN", "--json"];
        return { kind, token, ...await runZinn(args, dir, { AI_AGENT: "concurrency-test" }) };
      }));

      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const data = JSON.parse(result.stdout);
        if (result.kind === "task") {
          taskKeys.push(data.key);
          titles.push(result.token);
        } else if (result.kind === "comment") {
          commentKeys.push(data.key);
          comments.push(result.token);
        } else {
          expect(Array.isArray(data)).toBe(true);
        }
      }
    }

    expect(new Set(taskKeys).size).toBe(titles.length);
    expect(new Set(commentKeys).size).toBe(comments.length);
    withTestDb(dir, (db) => {
      const tasks = db.query<{ id: string; number: number; title: string; task_order: string; comment_count: number }, []>(
        "SELECT id, number, title, task_order, comment_count FROM task ORDER BY number",
      ).all();
      const storedComments = db.query<{ number: number; text: string }, []>(
        "SELECT number, text FROM comment ORDER BY number",
      ).all();
      expect(tasks.map((task) => task.title).sort()).toEqual([...titles].sort());
      expect(tasks.map((task) => task.number)).toEqual(Array.from({ length: titles.length }, (_, index) => index + 1));
      expect(new Set(tasks.map((task) => task.task_order)).size).toBe(tasks.length);
      expect(storedComments.map((comment) => comment.text).sort()).toEqual([...comments].sort());
      expect(storedComments.map((comment) => comment.number)).toEqual(Array.from({ length: comments.length }, (_, index) => index + 1));
      expect(tasks[0]!.comment_count).toBe(comments.length);
      expect(db.query("SELECT task_count FROM project WHERE key = 'BEN'").get()).toEqual({ task_count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE entity_type = 'task' AND action = 'create'").get()).toEqual({ count: tasks.length });
      expect(db.query("SELECT COUNT(*) AS count FROM activity WHERE action = 'comment_create'").get()).toEqual({ count: comments.length });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: tasks.length });

      for (const task of tasks) {
        expect(db.query("SELECT title FROM task_search WHERE task_id = ?").get(task.id)).toEqual({ title: task.title });
      }
      for (const token of comments) {
        expect(db.query("SELECT task_id FROM task_search WHERE task_search MATCH ?").all(token)).toEqual([{ task_id: tasks[0]!.id }]);
      }
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
}, 60_000);

test.serial("a CLI writer waits for a held lock and succeeds after release", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "WAIT"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();
    const release = setTimeout(() => db.run("ROLLBACK"), 250);

    try {
      const result = await runZinn(["task", "create", "WAIT", "--title", "waited", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).key).toBe("WAIT-1");
      expect(performance.now() - began).toBeGreaterThanOrEqual(250);
      expect(db.query("SELECT title FROM task").all()).toEqual([{ title: "waited" }]);
    } finally {
      clearTimeout(release);
      if (db.inTransaction) {
        db.run("ROLLBACK");
      }
      db.close();
    }
  });
}, 45_000);

test.serial("persistent contention times out without a partial CLI mutation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    expect((await runZinn(["project", "create", "LOCK"], dir)).code).toBe(0);
    const db = new Database(join(dir, "data", "zinn.sqlite"));
    db.run("BEGIN IMMEDIATE");
    const began = performance.now();

    try {
      const result = await runZinn(["task", "create", "LOCK", "--title", "must not persist", "--json"], dir, { AI_AGENT: "concurrency-test" });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const busy = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(busy).toMatchObject({ code: "storage", details: { reason: "busy", cause: { code: "SQLITE_BUSY" } } });
      expect(readFileSync(busy.details!.logPath!, "utf8")).toContain(busy.details!.cause!.code!);
      expect(performance.now() - began).toBeGreaterThanOrEqual(29_000);
      expect(performance.now() - began).toBeLessThan(40_000);
      expect(db.query("SELECT COUNT(*) AS count FROM task").get()).toEqual({ count: 0 });
      expect(db.query("SELECT task_count FROM project WHERE key = 'LOCK'").get()).toEqual({ task_count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM task_search").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM activity").get()).toEqual({ count: 1 });
    } finally {
      db.run("ROLLBACK");
      db.close();
    }
  });
}, 45_000);

test("CLI initialization errors expose the underlying message and code", async () => {
  await withIsolatedZinnDir(async (dir) => {
    mkdirSync(join(dir, "data"));
    const contents = "not a SQLite database";
    const path = join(dir, "data", "zinn.sqlite");
    writeFileSync(path, contents);
    const result = await runZinn(["project", "list", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(result.stderr)).error).toMatchObject({ code: "storage", details: { reason: "not_database", cause: { code: "SQLITE_NOTADB", errcode: 26 } } });

    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});

// --- SETTINGS (ZINN-56)

// ? Runs the bin from cwd with ZINN_DIR unset and a temporary HOME inside testDir, so the settings files choose the store.
async function runZinnFrom(args: Array<string>, testDir: string, cwd: string) {
  const env: Record<string, string | undefined> = { ...TEST_ENVIRONMENT, HOME: join(testDir, "home") };
  delete env.ZINN_DIR;
  return runProcessAsync([process.execPath, CLI_PATH, ...args], { cwd, env });
}

/** A repository inside testDir holding a zinn.local.json with the given content. */
function repositoryWithSettings(testDir: string, content: string) {
  const repository = join(testDir, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(testDir, "home"));
  writeFileSync(join(repository, "zinn.local.json"), content);

  return repository;
}

test("storage.directory in zinn.local.json chooses the store, from any folder of the repository", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: "../store" } }));
    mkdirSync(join(dir, "store"));
    const nested = join(repository, "src");
    mkdirSync(nested);

    expect((await runZinnFrom(["project", "create", "SET"], dir, repository)).code).toBe(0);
    expect((await runZinnFrom(["project", "list", "--json"], dir, nested)).stdout).toContain('"key": "SET"');
    expect(withTestDb(join(dir, "store"), (db) => db.query("SELECT key FROM project").all())).toEqual([{ key: "SET" }]);
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
  });
});

test("an invalid zinn.local.json fails the command with the file's path, without a stack trace, before creating a store", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const repository = repositoryWithSettings(dir, JSON.stringify({ storage: { directory: 42 } }));
    const settingsPath = join(realpathSync(repository), "zinn.local.json");

    const result = await runZinnFrom(["project", "create", "SET"], dir, repository);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(settingsPath);
    expect(result.stderr).toContain("storage.directory");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "home", ".zinn"))).toBe(false);
    expect(readdirSync(repository).sort()).toEqual([".git", "zinn.local.json"]);
  });
});

// --- PARTIAL TEXT EDITS (ZINN-177)

// ? Creates project APP with task APP-1, label bug and comment APP-1#1, all with the given text.
async function seedEditableText(dir: string, text: string) {
  const run = (...args: string[]) => runZinn(args, dir);
  expect((await run("project", "create", "APP", "--description", text)).code).toBe(0);
  expect((await run("task", "create", "APP", "--title", "Task", "--description", text)).code).toBe(0);
  expect((await run("label", "create", "bug", "--description", text)).code).toBe(0);
  expect((await run("task", "comment", "create", "APP-1", "--text", text)).code).toBe(0);

  return run;
}

const storedTextOf = (dir: string) =>
  withTestDb(dir, (db) => ({
    project: db.query<{ text: string | null }, []>("SELECT description AS text FROM project").get()!.text,
    task: db.query<{ text: string | null }, []>("SELECT description AS text FROM task").get()!.text,
    label: db.query<{ text: string | null }, []>("SELECT description AS text FROM label").get()!.text,
    comment: db.query<{ text: string }, []>("SELECT text FROM comment").get()!.text,
  }));

test("oversized partial text edits exit 1 with empty stdout and leave the database unchanged", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Seed");
    const atLimit = "a".repeat(MAX_TEXT_BYTES - 4) + "😀";
    withTestDb(dir, (db) => {
      for (const table of ["project", "task", "label"]) {
        db.query(`UPDATE ${table} SET description = ?`).run(atLimit);
      }
      db.query("UPDATE comment SET text = ?").run(atLimit);
    });
    const before = storedTextOf(dir);
    const activities = (await run("activity", "list", "--json")).stdout;
    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      for (const options of [[flag, "x", "--append"], [flag, "😀x", "--replacing", "😀"]]) {
        const result = await run(...args, ...options);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES));
        expect(result.stderr).toContain(String(MAX_TEXT_BYTES + (options.includes("--append") ? 3 : 1)));
        expect(storedTextOf(dir)).toEqual(before);
        expect((await run("activity", "list", "--json")).stdout).toBe(activities);
      }
    }
  });
});

test("CRLF text normalizes through CLI creation, replacement and append for every text field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "  First\r\nSecond\nThird\rEnd  ");
    const normalized = "  First\nSecond\nThird\rEnd  ";
    expect(storedTextOf(dir)).toEqual({ project: normalized, task: normalized, label: normalized, comment: normalized });

    const edits = [
      { args: ["project", "edit", "APP"], flag: "--description" },
      { args: ["task", "edit", "APP-1"], flag: "--description" },
      { args: ["label", "edit", "bug"], flag: "--description" },
      { args: ["task", "comment", "edit", "APP-1#1"], flag: "--text" },
    ];
    for (const { args, flag } of edits) {
      const result = await run(...args, flag, "Joined\r\nLine", "--replacing", "First\r\nSecond", "--json");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const entity = JSON.parse(result.stdout);
      expect(entity.description ?? entity.text).toBe("  Joined\nLine\nThird\rEnd  ");
      expect((await run(...args, flag, "Tail\r\n  Indent", "--append")).code).toBe(0);
    }
    const appended = "  Joined\nLine\nThird\rEnd  \n\nTail\n  Indent";
    expect(storedTextOf(dir)).toEqual({ project: appended, task: appended, label: appended, comment: appended });
  });
});

test("--append adds a paragraph to a task description and to a comment's text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "First.\n");

    expect((await run("task", "edit", "APP-1", "--description", "Second.", "--append")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "More.", "--append")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "First.\n\nSecond.", comment: "First.\n\nMore." });
  });
});

test("--replacing swaps one passage in a project description and in a label description", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "old sentence, kept");

    expect((await run("project", "edit", "APP", "--description", "new", "--replacing", "old sentence")).code).toBe(0);
    expect((await run("label", "edit", "bug", "--description", "fresh", "--replacing", "old sentence")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ project: "new, kept", label: "fresh, kept" });
  });
});

test("--replacing --all replaces every match and prints the edited object as any edit does", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "board and board");

    const edited = await run("project", "edit", "APP", "--description", "database", "--replacing", "board", "--all");
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain("database and database");
    expect(storedTextOf(dir).project).toBe("database and database");

    const comment = await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "board", "--all");
    expect(comment.code).toBe(0);
    expect(comment.stdout).toContain("x and x");
  });
});

test("--replacing with several matches and no --all fails with the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json"),
      await run("project", "edit", "APP", "--description", "x", "--replacing", "dup", "--json"),
      await run("task", "comment", "edit", "APP-1#1", "--text", "x", "--replacing", "dup", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(attempt.stdout).toBe("");
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 2 } });
      expect(JSON.parse(attempt.stderr).error.message).toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("--replacing with no match fails without the --all hint and changes nothing", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "Some Text");
    const before = storedTextOf(dir);

    const attempts = [
      await run("task", "edit", "APP-1", "--description", "x", "--replacing", "some text", "--json"),
      await run("label", "edit", "bug", "--description", "x", "--replacing", "absent", "--json"),
    ];

    for (const attempt of attempts) {
      expect(attempt.code).toBe(1);
      expect(errorDocumentSchema.parse(JSON.parse(attempt.stderr)).error).toMatchObject({ code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] } });
      expect(attempt.stderr).not.toContain("--all");
    }
    expect(storedTextOf(dir)).toEqual(before);
  });
});

test("an empty text with --replacing deletes the match", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "keep\nstale line\n");

    expect((await run("task", "edit", "APP-1", "--description", "", "--replacing", "stale line\n")).code).toBe(0);
    expect((await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "\nstale line")).code).toBe(0);

    expect(storedTextOf(dir)).toMatchObject({ task: "keep\n", comment: "keep\n" });
  });
});

test("a modifier edit with --json carries the full resulting text", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "One.");

    const task = JSON.parse((await run("task", "edit", "APP-1", "--description", "Two.", "--append", "--json")).stdout);
    const comment = JSON.parse((await run("task", "comment", "edit", "APP-1#1", "--text", "Two.", "--append", "--json")).stdout);

    expect(task.description).toBe("One.\n\nTwo.");
    expect(comment.text).toBe("One.\n\nTwo.");
  });
});

test("a match error with --json uses the usual error shape, with the hint for several matches", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "dup dup");

    const several = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "dup", "--json");
    const none = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "absent", "--json");

    expect(several.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(several.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 2, field: ["description"] },
    });
    expect(JSON.parse(several.stderr).error.message).toContain("--all");
    expect(errorDocumentSchema.parse(JSON.parse(none.stderr)).error).toMatchObject({
      code: "conflict", details: { reason: "text_match_count", matchCount: 0, field: ["description"] },
    });
  });
});

test("the text-edit flags are usage errors without the text flag or in an invalid combination", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");
    const before = storedTextOf(dir);

    const cases: Array<[Array<string>, string]> = [
      [["task", "edit", "APP-1", "--append"], '--append --description'],
      [["project", "edit", "APP", "--name", "New", "--replacing", "a"], '--replacing --description'],
      [["label", "edit", "bug", "--color", "red", "--append"], '--append --description'],
      [["task", "comment", "edit", "APP-1#1", "--replacing", "a"], '--replacing --text'],
      [["task", "edit", "APP-1", "--description", "x", "--all"], '--all --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--all"], '--all --replacing'],
      [["task", "edit", "APP-1", "--description", "x", "--append", "--replacing", "t"], '--append --replacing'],
      [["task", "comment", "edit", "APP-1#1", "--text", "x", "--append", "--replacing", "t"], '--append --replacing'],
    ];

    for (const [args, message] of cases) {
      const result = await run(...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const flag of message.split(" ")) {
        expect(result.stderr).toContain(flag);
      }
    }
    expect(storedTextOf(dir)).toEqual(before);
    expect(errorDocumentSchema.parse(JSON.parse((await run("task", "edit", "APP-1", "--append", "--json")).stderr)).error).toMatchObject({
      code: "invalid_input", details: { argument: "--description" },
    });
  });
});

test("core's value rules for the text-edit flags identify the rejected field", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    const blankAppend = await run("task", "edit", "APP-1", "--description", " ", "--append", "--json");
    const emptyFind = await run("task", "edit", "APP-1", "--description", "x", "--replacing", "", "--json");
    const blankComment = await run("task", "comment", "edit", "APP-1#1", "--text", "", "--replacing", "text", "--json");

    expect(blankAppend.code).toBe(1);
    expect(blankAppend.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankAppend.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "append"] } });
    expect(emptyFind.code).toBe(1);
    expect(emptyFind.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(emptyFind.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["description", "find"] } });
    expect(blankComment.code).toBe(1);
    expect(blankComment.stdout).toBe("");
    expect(errorDocumentSchema.parse(JSON.parse(blankComment.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: [] } });
  });
});

test("the text-edit flags are limited to the edit commands and listed in their help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const run = await seedEditableText(dir, "text");

    expect((await run("task", "create", "APP", "--title", "T", "--append")).code).toBe(1);
    expect((await run("task", "comment", "create", "APP-1", "--text", "x", "--append")).code).toBe(1);

    for (const command of [["task", "edit"], ["project", "edit"], ["label", "edit"], ["task", "comment", "edit"]]) {
      const help = (await run(...command, "--help")).stdout;
      expect(help).toContain("[--append|--replacing <old> [--all]]");
      expect(help).toContain("--append");
    }
  });
});
