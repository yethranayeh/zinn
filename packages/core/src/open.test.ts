/**
 * How getDb() opens each kind of database (ZINN-118), run in child processes,
 *  since core resolves its folder from HOME and ZINN_DIR once, when it is first used.
 * Default-database fixtures live in a temporary HOME with ZINN_DIR unset. Each child checks
 *  where core resolved its folder and exits before opening anything if it is not the expected one.
 * Older databases come from a test-only version 2 that the child puts in place of the shipped,
 *  empty migration list, and a published core comes from replacing core's release reading.
 */
import type { ReleaseMode } from "./release";

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "#sqlite";

import { createBaseline } from "./migrations/baseline";
import { readSchemaVersion } from "./migrations/runner";
import { schemaObjects, seedBaseline, snapshot } from "./migrations/testing";

const HOME_PREFIX = join(tmpdir(), "zinn-open-home-");
/** The default folder of this test process's own HOME, which no child may open. */
const TEST_PROCESS_DEFAULT_DIR = join(homedir(), ".zinn");
/** The child's exit code when core resolved a folder other than the expected one. */
const WRONG_FOLDER_EXIT = 3;
const NEWER_VERSION = 9;
const UNMARKED_VERSION = 0;
const TEST_CLIENT = { client: "test", version: "1.0.0", executable: "/test/zinn" };

function modulePath(path: string) {
  return JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
}

function removeHome(home: string) {
  if (!home.startsWith(HOME_PREFIX)) {
    throw new Error(`Refusing to delete "${home}": not a ${HOME_PREFIX}* directory`);
  }

  rmSync(home, { recursive: true, force: true });
}

/** A temporary HOME, removed afterwards. Default databases live in its .zinn folder. */
function withHome(check: (home: string) => void) {
  const home = mkdtempSync(HOME_PREFIX);

  try {
    check(home);
  } finally {
    removeHome(home);
  }
}

async function withHomeAsync(check: (home: string) => Promise<void>) {
  const home = mkdtempSync(HOME_PREFIX);

  try {
    await check(home);
  } finally {
    removeHome(home);
  }
}

type Location = { home: string; zinnDir?: string };

function mainDirOf({ home, zinnDir }: Location) {
  return zinnDir ?? join(home, ".zinn");
}

function childEnvironment({ home, zinnDir }: Location) {
  const environment: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete environment.ZINN_DIR;

  if (zinnDir != null) {
    environment.ZINN_DIR = zinnDir;
  }

  return environment;
}

/** The child's command: the folder check, then script. */
function childCommand(location: Location, script: string) {
  return [
    process.execPath,
    "--eval",
    `
      const { storage } = await import(${modulePath("./constant.ts")});
      const { directory, databasePath } = storage();
      const isTestProcessDefaultDir = databasePath.startsWith(${JSON.stringify(TEST_PROCESS_DEFAULT_DIR)});
      if (directory !== ${JSON.stringify(mainDirOf(location))} || isTestProcessDefaultDir) {
        console.log(JSON.stringify({ wrongFolder: directory }));
        process.exit(${WRONG_FOLDER_EXIT});
      }
      ${script}
    `,
  ];
}

/** Runs script in a child and returns the JSON on the last line of its output. */
function runChild(location: Location, script: string) {
  const result = Bun.spawnSync(childCommand(location, script), { env: childEnvironment(location) });

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
}

type OpenCase = {
  /** Core's release mode. Without it, core reads its own, which is source in this folder. */
  coreRelease?: ReleaseMode;
  clientRelease?: ReleaseMode;
  allowsLegacyRead?: boolean;
  /** Puts a test-only version 2 in place of the shipped migrations. */
  migration?: "adds a table" | "fails";
  /** The project key the child tries to create, or null to only read. */
  createKey?: string | null;
};

/** Sets up the child's core for an OpenCase, leaving `core`, `actor` and `describeError` in scope. */
function coreSetup({
  coreRelease,
  clientRelease = "source",
  allowsLegacyRead = false,
  migration,
}: OpenCase) {
  const migrations = {
    "adds a table": `{ version: 2, name: "add test_addition", rebuilds: [], apply: (db) => db.exec("CREATE TABLE test_addition (id TEXT PRIMARY KEY)") }`,
    fails: `{ version: 2, name: "fail on purpose", rebuilds: [], apply: () => { throw new Error("planned migration failure"); } }`,
  };
  const releaseModule = modulePath("./release.ts");
  const registryModule = modulePath("./migrations/registry.ts");

  return `
    const { mock } = await import("bun:test");
    const release = { ...(await import(${releaseModule})) };
    const registry = { ...(await import(${registryModule})) };
    ${coreRelease == null ? "" : `mock.module(${releaseModule}, () => ({ ...release, readCoreReleaseMode: () => ${JSON.stringify(coreRelease)} }));`}
    ${migration == null ? "" : `mock.module(${registryModule}, () => ({ ...registry, MIGRATIONS: [${migrations[migration]}] }));`}
    const core = await import(${modulePath("../index.ts")});
    core.configureDatabase({ ...${JSON.stringify(TEST_CLIENT)}, release: ${JSON.stringify(clientRelease)}, allowsLegacyRead: ${allowsLegacyRead} });
    const actor = { name: "Test Human", email: null, kind: "human" };
    const describeError = (error) => ({ name: error.name, reason: error.reason, message: error.message });
  `;
}

/** A child that lists projects, then creates one unless createKey is null. */
function openScript(openCase: OpenCase) {
  const { createKey = "NEW" } = openCase;
  const write =
    createKey == null
      ? ""
      : `
    try {
      core.project.create({ key: ${JSON.stringify(createKey)} }, actor);
      outcome.wrote = true;
    } catch (error) {
      outcome.writeError = describeError(error);
    }`;

  return `
    ${coreSetup(openCase)}
    const outcome = {};
    try {
      outcome.projects = core.project.getAll().map((match) => match.key);
    } catch (error) {
      outcome.readError = describeError(error);
    }
    ${write}
    console.log(JSON.stringify(outcome));
  `;
}

function databasePath(mainDir: string) {
  return join(mainDir, "data", "zinn.sqlite");
}

function withDatabase<T>(mainDir: string, read: (db: ReturnType<typeof openDatabase>) => T) {
  const db = openDatabase(databasePath(mainDir));

  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** A database holding project APP, its tasks and their child rows, at the given schema version. */
function createDatabase(mainDir: string, version: number) {
  mkdirSync(join(mainDir, "data"), { recursive: true });
  withDatabase(mainDir, (db) => {
    db.exec("PRAGMA journal_mode = WAL");
    seedBaseline(db);
    db.exec(`PRAGMA user_version = ${version}`);
  });
}

function readDatabase(mainDir: string) {
  return withDatabase(mainDir, (db) => snapshot(db));
}

function backupsOf(mainDir: string) {
  const directory = join(mainDir, "backups");
  return existsSync(directory) ? readdirSync(directory) : [];
}

function projectKeys(mainDir: string) {
  return withDatabase(mainDir, (db) =>
    db
      .query<{ key: string }>("SELECT key FROM project ORDER BY key")
      .all()
      .map(({ key }) => key),
  );
}

test("a default-database fixture resolves inside the test's HOME, and ZINN_DIR still overrides it", () => {
  withHome((home) => {
    const defaultDir = join(home, ".zinn");
    expect(runChild({ home }, `console.log(JSON.stringify({ DB_PATH: databasePath, MAIN_DIR: directory }));`)).toEqual({
      DB_PATH: databasePath(defaultDir),
      MAIN_DIR: defaultDir,
    });

    const isolated = join(home, "isolated");
    expect(
      runChild({ home, zinnDir: isolated }, `console.log(JSON.stringify({ MAIN_DIR: directory }));`),
    ).toEqual({ MAIN_DIR: isolated });
  });
});

test("a missing default database is created at the latest version, without a settings file", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");

    expect(runChild({ home }, openScript({}))).toEqual({ projects: [], wrote: true });
    expect(readDatabase(mainDir).version).toBe(1);
    expect(projectKeys(mainDir)).toEqual(["NEW"]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

test("a current default database opens for writing, and opening it changes nothing and makes no backup", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, 1);
    const before = readDatabase(mainDir);

    expect(runChild({ home }, openScript({ createKey: null }))).toEqual({ projects: ["APP"] });
    expect(readDatabase(mainDir)).toEqual(before);
    expect(runChild({ home }, openScript({}))).toEqual({ projects: ["APP"], wrote: true });
    expect(readDatabase(mainDir).version).toBe(1);
    expect(backupsOf(mainDir)).toEqual([]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

/** Opens an older database, which a source build keeps read-only when it is the default database. */
function expectOlderReadOnly(location: Location, openCase: OpenCase) {
  const mainDir = mainDirOf(location);
  const before = readDatabase(mainDir);
  const outcome = runChild(location, openScript({ migration: "adds a table", ...openCase }));

  expect(outcome.projects).toEqual(["APP"]);
  expect(outcome.writeError.name).toBe("ReadOnlyDatabaseError");
  expect(outcome.writeError.reason).toBe("older");
  expect(outcome.writeError.message).toContain(databasePath(mainDir));
  expect(outcome.writeError.message).toContain("schema version 1");
  expect(outcome.writeError.message).toContain("uses version 2");
  expect(outcome.writeError.message).toContain("only through an explicit migration");
  expect(readDatabase(mainDir)).toEqual(before);
  expect(backupsOf(mainDir)).toEqual([]);
}

/** Opens an older database that upgrades by itself, and checks the kept backup. */
function expectOlderUpgraded(location: Location, openCase: OpenCase) {
  const mainDir = mainDirOf(location);
  const outcome = runChild(location, openScript({ migration: "adds a table", ...openCase }));

  expect(outcome).toEqual({ projects: ["APP"], wrote: true });
  withDatabase(mainDir, (db) => {
    expect(readSchemaVersion(db)).toBe(2);
    expect(schemaObjects(db).map(({ name }) => name)).toContain("test_addition");
  });
  expect(projectKeys(mainDir)).toEqual(["APP", "NEW"]);

  const backups = backupsOf(mainDir);
  expect(backups).toHaveLength(1);
  expect(backups[0]).toContain(`-${TEST_CLIENT.client}-${TEST_CLIENT.version}-`);

  const backup = openDatabase(join(mainDir, "backups", backups[0]!));
  try {
    expect(readSchemaVersion(backup)).toBe(1);
    expect(schemaObjects(backup).map(({ name }) => name)).not.toContain("test_addition");
  } finally {
    backup.close();
  }
}

test.each([
  { name: "core reading its own release, a source client", core: undefined, client: "source" },
  { name: "a source core, a published client", core: "source", client: "published" },
  { name: "a published core, a source client", core: "published", client: "source" },
] as const)("an older default database stays read-only with $name", ({ core, client }) => {
  withHome((home) => {
    createDatabase(join(home, ".zinn"), 1);
    expectOlderReadOnly({ home }, { coreRelease: core, clientRelease: client });
  });
});

test("an older default database upgrades by itself when core and client are both published, keeping its backup", () => {
  withHome((home) => {
    createDatabase(join(home, ".zinn"), 1);
    expectOlderUpgraded({ home }, { coreRelease: "published", clientRelease: "published" });
  });
});

test("an older isolated database upgrades by itself on a source build, keeping its backup", () => {
  withHome((home) => {
    const location = { home, zinnDir: join(home, "isolated") };
    createDatabase(location.zinnDir, 1);
    expectOlderUpgraded(location, {});
  });
});

test("a ZINN_DIR that reaches the default folder through a link or a parent step counts as the default database", () => {
  withHome((home) => {
    const defaultDir = join(home, ".zinn");
    const link = join(home, "link");
    mkdirSync(join(home, "other"));
    symlinkSync(defaultDir, link);
    createDatabase(defaultDir, 1);

    expectOlderReadOnly({ home, zinnDir: link }, {});
    expectOlderReadOnly({ home, zinnDir: join(home, "other", "..", ".zinn") }, {});
    expectOlderUpgraded(
      { home, zinnDir: link },
      { coreRelease: "published", clientRelease: "published" },
    );
  });
});

test("a failed automatic upgrade fails the command and leaves the database as it was", () => {
  withHome((home) => {
    const location = { home, zinnDir: join(home, "isolated") };
    createDatabase(location.zinnDir, 1);
    const before = readDatabase(location.zinnDir);
    const outcome = runChild(location, openScript({ migration: "fails", createKey: null }));

    expect(outcome.readError.message).toContain("There was a problem initializing Zinn");
    expect(outcome.readError.message).toContain("planned migration failure");
    expect(readDatabase(location.zinnDir)).toEqual(before);
    // The snapshot taken before the upgrade is kept.
    expect(backupsOf(location.zinnDir)).toHaveLength(1);
  });
});

test.each([
  { kind: "default", core: undefined, client: "source" },
  { kind: "isolated", core: "published", client: "published" },
] as const)(
  "a newer $kind database opens read-only and names both versions, the build and its executable",
  ({ kind, core, client }) => {
    withHome((home) => {
      const location = kind === "default" ? { home } : { home, zinnDir: join(home, "isolated") };
      const mainDir = mainDirOf(location);
      createDatabase(mainDir, NEWER_VERSION);
      const before = readDatabase(mainDir);
      const outcome = runChild(location, openScript({ coreRelease: core, clientRelease: client }));

      expect(outcome.projects).toEqual(["APP"]);
      expect(outcome.writeError.name).toBe("ReadOnlyDatabaseError");
      expect(outcome.writeError.reason).toBe("newer");
      expect(outcome.writeError.message).toContain(databasePath(mainDir));
      expect(outcome.writeError.message).toContain(`schema version ${NEWER_VERSION}`);
      expect(outcome.writeError.message).toContain("reaches only version 1");
      expect(outcome.writeError.message).toContain("test 1.0.0, run from /test/zinn");
      expect(readDatabase(mainDir)).toEqual(before);
      expect(backupsOf(mainDir)).toEqual([]);
    });
  },
);

test("an unmarked database is refused, for reads and writes, unless the client allows legacy reads", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, UNMARKED_VERSION);
    const before = readDatabase(mainDir);
    const refused = runChild(
      { home },
      openScript({ coreRelease: "published", clientRelease: "published" }),
    );

    expect(refused.readError.name).toBe("UnmarkedDatabaseError");
    expect(refused.readError.message).toContain(databasePath(mainDir));
    expect(refused.readError.message).toContain("no schema version");
    expect(refused.writeError.name).toBe("UnmarkedDatabaseError");

    const allowed = runChild({ home }, openScript({ allowsLegacyRead: true }));
    expect(allowed.projects).toEqual(["APP"]);
    expect(allowed.writeError.name).toBe("ReadOnlyDatabaseError");
    expect(allowed.writeError.message).toContain("open for reading only");

    expect(readDatabase(mainDir)).toEqual(before);
    expect(backupsOf(mainDir)).toEqual([]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

/** A child that reports every onLegacyRead call, after listing projects and trying a write. */
function legacyReadReportScript() {
  return `
    ${coreSetup({ allowsLegacyRead: true })}
    const legacyReads = [];
    core.configureDatabase({ ...${JSON.stringify(TEST_CLIENT)}, release: "source", allowsLegacyRead: true, onLegacyRead: (facts) => legacyReads.push(facts) });
    core.project.getAll();
    core.project.getAll();
    try { core.project.create({ key: "NEW" }, actor); } catch {}
    console.log(JSON.stringify({ legacyReads }));
  `;
}

test("core reports an unmarked database opened for reading once, and no other state", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, UNMARKED_VERSION);

    expect(runChild({ home }, legacyReadReportScript()).legacyReads).toEqual([
      { databasePath: databasePath(mainDir), version: UNMARKED_VERSION, latestVersion: 1 },
    ]);
  });

  for (const version of [1, NEWER_VERSION]) {
    withHome((home) => {
      createDatabase(join(home, ".zinn"), version);

      expect(runChild({ home }, legacyReadReportScript()).legacyReads).toEqual([]);
    });
  }
});

test("an unmarked database missing tables gets none created, even when a write is attempted", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    mkdirSync(join(mainDir, "data"), { recursive: true });
    withDatabase(mainDir, (db) => {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`CREATE TABLE project (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
        task_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, archived_at INTEGER)`);
    });
    const before = readDatabase(mainDir);

    const outcome = runChild({ home }, openScript({ allowsLegacyRead: true }));
    expect(outcome.projects).toEqual([]);
    expect(outcome.writeError.name).toBe("ReadOnlyDatabaseError");
    expect(readDatabase(mainDir)).toEqual(before);
  });
});

/** The child of the mutation walk: lists every operation as a read or a mutation, and runs each. */
const OPERATIONS_WALK = `
  const { getDb } = await import(${modulePath("./db.ts")});
  const { project, column, task, comment, label, relation } = core;
  const { label: taskLabel, ...taskOperations } = task;
  const objects = { project, column, task: taskOperations, "task.label": taskLabel, comment, label, relation };

  const reads = {
    project: { getById: () => project.getById("p1"), getByKey: () => project.getByKey("APP"), getAll: () => project.getAll(), standardizeKey: () => project.standardizeKey("app") },
    column: { getById: () => column.getById("c1"), getAllByProjectKey: () => column.getAllByProjectKey("APP"), getTaskCountsByProjectKey: () => column.getTaskCountsByProjectKey("APP") },
    task: { getAll: () => task.getAll({}), getByKey: () => task.getByKey("APP-1"), search: () => task.search({ query: "First" }), activity: () => task.activity("APP-1") },
    "task.label": { getAll: () => task.label.getAll("APP-1") },
    comment: { getByKey: () => comment.getByKey("APP-1#1"), getAll: () => comment.getAll("APP-1") },
    label: { getAll: () => label.getAll(), getByName: () => label.getByName("bug") },
    relation: { getAll: () => relation.getAll("APP-1") },
  };
  const mutations = {
    project: {
      create: () => project.create({ key: "NEW" }, actor),
      edit: () => project.edit({ projectKey: "APP", name: "Renamed" }, actor),
      delete: () => project.delete("APP", actor),
    },
    column: {
      create: () => column.create({ projectKey: "APP", name: "Blocked" }, actor),
      edit: () => column.edit({ projectKey: "APP", columnName: "Todo", name: "Later" }, actor),
      order: () => column.order({ projectKey: "APP", columnName: "Todo", direction: "last" }, actor),
    },
    task: {
      create: () => task.create({ project_id: "p1", title: "New" }, actor),
      edit: () => task.edit({ taskKey: "APP-1", title: "Edited" }, actor),
      move: () => task.move({ taskKey: "APP-1", targetColumn: "Done" }, actor),
      moveMany: () => task.moveMany({ taskKeys: ["APP-1"], targetColumn: "Done" }, actor),
      order: () => task.order({ taskKey: "APP-1", direction: "bottom" }, actor),
      delete: () => task.delete("APP-1", actor),
      archive: () => task.archive("APP-1", actor),
      archiveMany: () => task.archiveMany(["APP-1"], actor),
      unarchive: () => task.unarchive("APP-3", actor),
      unarchiveMany: () => task.unarchiveMany(["APP-3"], actor),
    },
    "task.label": {
      add: () => task.label.add({ taskKey: "APP-2", labelNames: ["unused"] }, actor),
      remove: () => task.label.remove({ taskKey: "APP-1", labelNames: ["bug"] }, actor),
    },
    comment: {
      create: () => comment.create({ taskKey: "APP-1", text: "New" }, actor),
      edit: () => comment.edit({ commentKey: "APP-1#1", text: "Edited" }, actor),
      delete: () => comment.delete({ commentKey: "APP-1#1" }, actor),
    },
    label: {
      create: () => label.create({ name: "new" }, actor),
      edit: () => label.edit({ labelName: "bug", color: "blue" }, actor),
      delete: () => label.delete({ name: "unused" }, actor),
    },
    relation: {
      create: () => relation.create({ sourceTaskKey: "APP-1", targetTaskKey: "APP-3", relation_type: "related" }, actor),
      delete: () => relation.delete({ sourceTaskKey: "APP-1", targetTaskKey: "APP-2", relation_type: "subtask" }, actor),
    },
  };

  const unlisted = [];
  for (const [name, object] of Object.entries(objects)) {
    for (const [key, value] of Object.entries(object)) {
      const isListed = key in reads[name] || key in mutations[name];
      if (typeof value === "function" && !isListed) {
        unlisted.push(name + "." + key);
      }
    }
  }

  const outcomes = {};
  for (const [name, calls] of Object.entries(mutations)) {
    for (const [key, call] of Object.entries(calls)) {
      try {
        call();
        outcomes[name + "." + key] = "changed";
      } catch (error) {
        outcomes[name + "." + key] = error.name;
      }
    }
  }

  const readErrors = [];
  for (const [name, calls] of Object.entries(reads)) {
    for (const [key, call] of Object.entries(calls)) {
      try {
        call();
      } catch (error) {
        readErrors.push(name + "." + key + ": " + error.message);
      }
    }
  }

  let rawWrite = "written";
  try {
    getDb().exec("INSERT INTO label (id, name, color) VALUES ('l9', 'raw', 'red')");
  } catch (error) {
    rawWrite = error.code;
  }

  console.log(JSON.stringify({ unlisted, outcomes, readErrors, rawWrite }));
`;
const MUTATION_COUNT = 26;

test("every core mutation is refused before any SQL runs on a read-only database, while every read works", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, NEWER_VERSION);
    const before = readDatabase(mainDir);
    const result = runChild({ home }, `${coreSetup({})}\n${OPERATIONS_WALK}`);

    expect(result.unlisted).toEqual([]);
    expect(Object.keys(result.outcomes)).toHaveLength(MUTATION_COUNT);
    for (const [mutation, outcome] of Object.entries(result.outcomes)) {
      expect({ mutation, outcome }).toEqual({ mutation, outcome: "ReadOnlyDatabaseError" });
    }
    expect(result.readErrors).toEqual([]);
    // query_only refuses a write that does not go through core's check.
    expect(result.rawWrite).toBe("SQLITE_READONLY");
    expect(readDatabase(mainDir)).toEqual(before);
  });
});

type ChunkReader = { read: () => Promise<{ value?: Uint8Array; done: boolean }> };

/** Reads until the output contains text, or to the end when text is null. */
async function readUntil(reader: ChunkReader, text: string | null) {
  const decoder = new TextDecoder();
  let output = "";

  while (text == null || !output.includes(text)) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    output += decoder.decode(value);
  }

  return output;
}

/** Reports each classification on stdout and the error of a lost creation race. */
const RACE_INSTRUMENTATION = `
  const { mock } = await import("bun:test");
  const classify = { ...(await import(${modulePath("./migrations/classify.ts")})) };
  const runner = { ...(await import(${modulePath("./migrations/runner.ts")})) };
  let lostRace = null;
  mock.module(${modulePath("./migrations/classify.ts")}, () => ({
    ...classify,
    classifyConnection: (db, migrations) => {
      const classification = classify.classifyConnection(db, migrations);
      console.log("CLASSIFIED " + classification.state);
      return classification;
    },
  }));
  mock.module(${modulePath("./migrations/runner.ts")}, () => ({
    ...runner,
    createSchema: (db, migrations) => {
      try {
        return runner.createSchema(db, migrations);
      } catch (error) {
        lostRace = error.name;
        throw error;
      }
    },
  }));
  const core = await import(${modulePath("../index.ts")});
  const actor = { name: "Test Human", email: null, kind: "human" };
  const created = core.project.create({ key: "LATE" }, actor);
  console.log(JSON.stringify({ lostRace, created: created.key }));
`;

test("a process that loses the race to create a fresh database opens the database the winner created", async () => {
  await withHomeAsync(async (home) => {
    const location = { home };
    const mainDir = join(home, ".zinn");
    mkdirSync(join(mainDir, "data"), { recursive: true });
    const winner = openDatabase(databasePath(mainDir));

    try {
      // WAL mode with no tables and no version, so the database is still fresh.
      winner.exec("PRAGMA journal_mode = WAL");
      winner.exec("CREATE TABLE placeholder (id INTEGER); DROP TABLE placeholder;");
      winner.exec("BEGIN IMMEDIATE");
      createBaseline(winner);
      winner.exec("PRAGMA user_version = 1");

      const child = Bun.spawn(childCommand(location, RACE_INSTRUMENTATION), {
        env: childEnvironment(location),
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = child.stdout.getReader();

      // The winner commits only once the child has found the database empty.
      const seen = await readUntil(reader, "CLASSIFIED empty");
      winner.exec("COMMIT");
      const output = seen + (await readUntil(reader, null));

      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      const lines = output.trim().split("\n");
      expect(lines.slice(0, 2)).toEqual(["CLASSIFIED empty", "CLASSIFIED current"]);
      expect(JSON.parse(lines.at(-1)!)).toEqual({
        lostRace: "SchemaNotEmptyError",
        created: "LATE",
      });
    } finally {
      if (winner.inTransaction) {
        winner.exec("ROLLBACK");
      }

      winner.close();
    }

    expect(readDatabase(mainDir).version).toBe(1);
    expect(projectKeys(mainDir)).toEqual(["LATE"]);
  });
});

test("processes that create a fresh default database at once all open it", async () => {
  await withHomeAsync(async (home) => {
    const location = { home };
    const keys = ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter) => `RACE${letter}`);
    const children = keys.map((key) =>
      Bun.spawn(childCommand(location, openScript({ createKey: key })), {
        env: childEnvironment(location),
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    for (const child of children) {
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(await new Response(child.stdout).text()).wrote).toBe(true);
    }

    const mainDir = join(home, ".zinn");
    expect(readDatabase(mainDir).version).toBe(1);
    expect(projectKeys(mainDir)).toEqual(keys);
  });
}, 30_000);
