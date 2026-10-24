import { openDatabase } from "#sqlite";
import { expect, spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../index";
import { CoreError, ReadOnlyDatabaseError } from "../index";
import { getStorage } from "./storage";
import { getDb } from "./db";
import { BASELINE_VERSION, createBaseline } from "./migrations/baseline";
import type { DatabaseFacts } from "./migrations/open-policy";
import type { Migration } from "./migrations/registry";
import { latestVersion, MIGRATIONS } from "./migrations/registry";
import { applyPendingMigrations, readSchemaVersion, upgradeSchema } from "./migrations/runner";
import { schemaObjects, seedBaseline, snapshot } from "./migrations/testing";
import type { ReleaseMode } from "./release";
import * as release from "./release";
import { withEnvironment } from "./testing";

const actor = { name: "Test Human", email: null, kind: "human" as const };
function describeError(error: unknown) {
  if (!(error instanceof Error)) { throw error; }
  return {
    name: error.name, message: error.message,
    ...(error instanceof CoreError ? { kind: error.kind, facts: error.facts } : {}),
    ...(error instanceof ReadOnlyDatabaseError ? { reason: error.reason } : {}),
  };
}
function withLocation<T>(location: Location, check: () => T): T {
  return withEnvironment({ HOME: location.home, ZINN_DIR: location.zinnDir }, () => {
    expect(getStorage().directory).toBe(mainDirOf(location));
    expect(getStorage().databasePath.startsWith(TEST_PROCESS_DEFAULT_DIR)).toBe(false);
    return check();
  }, location.cwd ?? location.home);
}
function configureCore(openCase: OpenCase) {
  core.configureDatabase({ ...TEST_CLIENT, release: openCase.clientRelease ?? "source", allowsLegacyRead: openCase.allowsLegacyRead ?? false });
}
function runOpen(location: Location, openCase: OpenCase) {
  const mutableMigrations = MIGRATIONS as Migration[];
  const originalMigrations = [...MIGRATIONS];
  const releaseSpy = openCase.coreRelease === undefined ? null : spyOn(release, "readCoreReleaseMode").mockReturnValue(openCase.coreRelease);
  if (openCase.migration !== undefined) {
    mutableMigrations.push({
      version: TEST_MIGRATION_VERSION, name: "test migration", rebuilds: [], apply: (db) => {
        if (openCase.migration === "fails") { throw new Error("planned migration failure"); }
        db.exec("CREATE TABLE test_addition (id TEXT PRIMARY KEY)");
      }
    });
  }
  try {
    return withLocation(location, () => {
      configureCore(openCase);
      const outcome: { projects?: string[]; wrote?: boolean; readError?: ReturnType<typeof describeError>; writeError?: ReturnType<typeof describeError> } = {};
      try { outcome.projects = core.project.getAll().map((match) => match.key); }
      catch (error) { outcome.readError = describeError(error); }
      const { createKey = "NEW" } = openCase;
      if (createKey !== null) {
        try { core.project.create({ key: createKey }, actor); outcome.wrote = true; }
        catch (error) { outcome.writeError = describeError(error); }
      }
      return outcome;
    });
  } finally {
    mutableMigrations.splice(0, MIGRATIONS.length, ...originalMigrations);
    releaseSpy?.mockRestore();
  }
}

const HOME_PREFIX = join(tmpdir(), "zinn-open-home-");
/** The default folder of this test process's own HOME, which no child may open. */
const TEST_PROCESS_DEFAULT_DIR = join(homedir(), ".zinn");
/** The child's exit code when core resolved a folder other than the expected one. */
const WRONG_FOLDER_EXIT = 3;
const NEWER_VERSION = 9;
const UNMARKED_VERSION = 0;
const TEST_CLIENT = { client: "test", version: "1.0.0", executable: "/test/zinn" };
const TEST_MIGRATION_VERSION = latestVersion(MIGRATIONS) + 1;

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

/** Where a child runs. `store` is the folder a settings file chooses, and `cwd` defaults to the HOME. */
type Location = { home: string; zinnDir?: string; store?: string; cwd?: string };

function mainDirOf({ home, zinnDir, store }: Location) {
  return zinnDir ?? store ?? join(home, ".zinn");
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
      const { getStorage } = await import(${modulePath("./storage.ts")});
      const { directory, databasePath } = getStorage();
      const isTestProcessDefaultDir = databasePath.startsWith(${JSON.stringify(TEST_PROCESS_DEFAULT_DIR)});
      if (directory !== ${JSON.stringify(mainDirOf(location))} || isTestProcessDefaultDir) {
        console.log(JSON.stringify({ wrongFolder: directory }));
        process.exit(${WRONG_FOLDER_EXIT});
      }
      ${script}
    `,
  ];
}

type OpenCase = {
  /** Core's release mode. Without it, core reads its own, which is source in this folder. */
  coreRelease?: ReleaseMode;
  clientRelease?: ReleaseMode;
  allowsLegacyRead?: boolean;
  /** Appends a test-only migration after the shipped migrations. */
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
    "adds a table": `{ version: registry.latestVersion(registry.MIGRATIONS) + 1, name: "add test_addition", rebuilds: [], apply: (db) => db.exec("CREATE TABLE test_addition (id TEXT PRIMARY KEY)") }`,
    fails: `{ version: registry.latestVersion(registry.MIGRATIONS) + 1, name: "fail on purpose", rebuilds: [], apply: () => { throw new Error("planned migration failure"); } }`,
  };
  const releaseModule = modulePath("./release.ts");
  const registryModule = modulePath("./migrations/registry.ts");

  return `
    const { mock } = await import("bun:test");
    const release = { ...(await import(${releaseModule})) };
    const registry = { ...(await import(${registryModule})) };
    ${coreRelease == null ? "" : `mock.module(${releaseModule}, () => ({ ...release, readCoreReleaseMode: () => ${JSON.stringify(coreRelease)} }));`}
    ${migration == null ? "" : `mock.module(${registryModule}, () => ({ ...registry, MIGRATIONS: [...registry.MIGRATIONS, ${migrations[migration]}] }));`}
    const core = await import(${modulePath("../index.ts")});
    core.configureDatabase({ ...${JSON.stringify(TEST_CLIENT)}, release: ${JSON.stringify(clientRelease)}, allowsLegacyRead: ${allowsLegacyRead} });
    const actor = { name: "Test Human", email: null, kind: "human" as const };
    const describeError = (error) => ({ name: error.name, reason: error.reason, facts: error.facts, message: error.message });
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

function createCurrentDatabase(mainDir: string) {
  createDatabase(mainDir, BASELINE_VERSION);
  withDatabase(mainDir, (db) => {
    upgradeSchema(db);
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
    expect(withLocation({ home }, () => ({ DB_PATH: getStorage().databasePath, MAIN_DIR: getStorage().directory }))).toEqual({
      DB_PATH: databasePath(defaultDir),
      MAIN_DIR: defaultDir,
    });

    const isolated = join(home, "isolated");
    mkdirSync(isolated);
    expect(
      withLocation({ home, zinnDir: isolated }, () => ({ MAIN_DIR: getStorage().directory })),
    ).toEqual({ MAIN_DIR: isolated });
  });
});

test("a missing default database is created at the latest version, without a settings file", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");

    expect(runOpen({ home }, {})).toEqual({ projects: [], wrote: true });
    expect(readDatabase(mainDir).version).toBe(latestVersion(MIGRATIONS));
    expect(projectKeys(mainDir)).toEqual(["NEW"]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

test("a current default database opens for writing, and opening it changes nothing and makes no backup", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createCurrentDatabase(mainDir);
    const before = readDatabase(mainDir);

    expect(runOpen({ home }, { createKey: null })).toEqual({ projects: ["APP"] });
    expect(readDatabase(mainDir)).toEqual(before);
    expect(runOpen({ home }, {})).toEqual({ projects: ["APP"], wrote: true });
    expect(readDatabase(mainDir).version).toBe(latestVersion(MIGRATIONS));
    expect(backupsOf(mainDir)).toEqual([]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

/** Opens an older database, which a source build keeps read-only when it is a protected database. */
function expectOlderReadOnly(location: Location, openCase: OpenCase) {
  const mainDir = mainDirOf(location);
  const before = readDatabase(mainDir);
  const outcome = runOpen(location, { migration: "adds a table", ...openCase });

  expect(outcome.projects).toEqual(["APP"]);
  expect(outcome.writeError!.name).toBe("ReadOnlyDatabaseError");
  expect(outcome.writeError!.reason).toBe("older");
  expect(outcome.writeError!.message).toContain(databasePath(mainDir));
  expect(outcome.writeError!.facts).toMatchObject({
    databasePath: databasePath(mainDir), schemaVersion: 1, supportedSchemaVersion: TEST_MIGRATION_VERSION,
  });
  expect(readDatabase(mainDir)).toEqual(before);
  expect(backupsOf(mainDir)).toEqual([]);
}

/** Opens an older database that upgrades by itself, and checks the kept backup. */
function expectOlderUpgraded(location: Location, openCase: OpenCase) {
  const mainDir = mainDirOf(location);
  const outcome = runOpen(location, { migration: "adds a table", ...openCase });

  expect(outcome).toEqual({ projects: ["APP"], wrote: true });
  withDatabase(mainDir, (db) => {
    expect(readSchemaVersion(db)).toBe(TEST_MIGRATION_VERSION);
    expect(schemaObjects(db).map(({ name }) => name)).toContain("test_addition");
  });
  expect(projectKeys(mainDir)).toEqual(["APP", "NEW"]);

  const backups = backupsOf(mainDir);
  expect(backups).toHaveLength(1);
  expect(backups[0]).toContain(`-${TEST_CLIENT.client}-${TEST_CLIENT.version}-`);

  const backup = openDatabase(join(mainDir, "backups", backups[0]!));
  try {
    expect(readSchemaVersion(backup)).toBe(BASELINE_VERSION);
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

/** A home with a repository whose zinn.local.json, or the global settings file, chooses a store outside the default folder. */
function settingsLocation(home: string, file: "local" | "global"): Location {
  const repository = join(home, "repository");
  // ? The local file is found from process.cwd(), which gives the real path; the global one from HOME as given.
  const store = join(file === "local" ? realpathSync(home) : home, `${file}-store`);
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(home, ".zinn"), { recursive: true });

  if (file === "local") {
    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ storage: { directory: "../local-store" } }));
  } else {
    writeFileSync(join(home, ".zinn", "settings.json"), JSON.stringify({ storage: { directory: "~/global-store" } }));
  }

  return { home, store, cwd: repository };
}

test.each(["local", "global"] as const)(
  "an older database in a store chosen by the %s settings file stays read-only on a source build",
  (file) => {
    withHome((home) => {
      const location = settingsLocation(home, file);
      createDatabase(location.store!, 1);
      expectOlderReadOnly(location, {});
    });
  },
);

test("an older database in a settings-chosen store upgrades by itself when core and client are both published", () => {
  withHome((home) => {
    const location = settingsLocation(home, "local");
    createDatabase(location.store!, 1);
    expectOlderUpgraded(location, { coreRelease: "published", clientRelease: "published" });
  });
});

/** Every file and folder under `directory`, to prove that a failed command left it as it was. */
function listTree(directory: string) {
  return readdirSync(directory, { recursive: true }).map(String).sort();
}

function databaseEntryAttempts() {
  const actor = { name: "Test Human", email: null, kind: "human" as const };
  const build = { client: "test", version: "1.0.0" };
  const attempts = {
    read: () => core.project.getAll(),
    write: () => core.project.create({ key: "NEW" }, actor),
    backup: () => core.backup.create(build),
    restore: () => core.backup.restore({ ...build, path: "backup.sqlite" }),
    migrate: () => core.migrate.run(build),
    reindex: () => core.reindex.run(),
  };
  const errors: Record<string, ReturnType<typeof describeError> | null> = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      attempt();
      errors[name] = null;
    } catch (error) {
      errors[name] = describeError(error);
    }
  }
  return errors;

}

test.each([
  { problem: "invalid JSON", content: '{ "storage": ', facts: { reason: "invalid_json" } },
  { problem: "an unknown key", content: JSON.stringify({ storge: { directory: "store" } }), facts: { reason: "invalid_settings", field: [] } },
  { problem: "a wrong type", content: JSON.stringify({ storage: { directory: 42 } }), facts: { reason: "invalid_settings", field: ["storage", "directory"] } },
])("a settings file with $problem fails every way into the database before any folder or database is created", ({ content, facts }) => {
  withHome((home) => {
    const repository = join(home, "repository");
    const settingsPath = join(repository, "zinn.local.json");
    mkdirSync(join(repository, ".git"), { recursive: true });
    writeFileSync(settingsPath, content);
    const before = listTree(repository);

    for (const zinnDir of [undefined, join(home, "isolated")]) {
      const selectedSettingsPath = zinnDir === undefined
        ? realpathSync(settingsPath)
        : join(zinnDir, "settings.json");
      if (zinnDir !== undefined) {
        mkdirSync(zinnDir);
        writeFileSync(selectedSettingsPath, content);
      }
      const selectedStoreBefore = zinnDir === undefined ? [] : listTree(zinnDir);
      const errors = withEnvironment({ HOME: home, ZINN_DIR: zinnDir }, databaseEntryAttempts, repository);
      expect(Object.keys(errors)).toHaveLength(6);
      for (const [attempt, error] of Object.entries(errors)) {
        expect({ attempt, error }).toMatchObject({ attempt, error: { kind: "input", facts: { ...facts, settingsPath: selectedSettingsPath }, message: expect.stringContaining(selectedSettingsPath) } });
      }
      // ? Bun keeps its own cache in the HOME, so only the store folders and the repository are checked.
      expect(existsSync(join(home, ".zinn"))).toBe(false);
      if (zinnDir === undefined) {
        expect(existsSync(join(home, "isolated"))).toBe(false);
      } else {
        expect(listTree(zinnDir)).toEqual(selectedStoreBefore);
      }
      expect(listTree(repository)).toEqual(before);
    }
  });
});

test("a failed automatic upgrade fails the command and leaves the database as it was", () => {
  withHome((home) => {
    const location = { home, zinnDir: join(home, "isolated") };
    createDatabase(location.zinnDir, 1);
    const before = readDatabase(location.zinnDir);
    const outcome = runOpen(location, { migration: "fails", createKey: null });

    expect(outcome.readError!.message).toContain("planned migration failure");
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
      const outcome = runOpen(location, { coreRelease: core, clientRelease: client });

      expect(outcome.projects).toEqual(["APP"]);
      expect(outcome.writeError!.name).toBe("ReadOnlyDatabaseError");
      expect(outcome.writeError!.reason).toBe("newer");
      expect(outcome.writeError!.message).toContain(databasePath(mainDir));
      expect(outcome.writeError!.facts).toMatchObject({ schemaVersion: NEWER_VERSION, supportedSchemaVersion: latestVersion(MIGRATIONS) });
      for (const fact of ["test", "1.0.0", "/test/zinn"]) {
        expect(outcome.writeError!.message).toContain(fact);
      }
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
    const refused = runOpen({ home }, { coreRelease: "published", clientRelease: "published" });

    expect(refused.readError!.name).toBe("UnmarkedDatabaseError");
    expect(refused.readError!.message).toContain(databasePath(mainDir));
    expect(refused.readError!.facts).toMatchObject({ reason: "unmarked_database", schemaVersion: 0 });
    expect(refused.writeError!.name).toBe("UnmarkedDatabaseError");

    const allowed = runOpen({ home }, { allowsLegacyRead: true });
    expect(allowed.projects).toEqual(["APP"]);
    expect(allowed.writeError!.name).toBe("ReadOnlyDatabaseError");
    expect(allowed.writeError!.reason).toBe("unmarked");

    expect(readDatabase(mainDir)).toEqual(before);
    expect(backupsOf(mainDir)).toEqual([]);
    expect(existsSync(join(mainDir, "settings.json"))).toBe(false);
  });
});

function legacyReadReport() {
  configureCore({ allowsLegacyRead: true });
  const legacyReads: DatabaseFacts[] = [];
  core.configureDatabase({ ...TEST_CLIENT, release: "source", allowsLegacyRead: true, onLegacyRead: (facts) => legacyReads.push(facts) });
  core.project.getAll();
  core.project.getAll();
  try { core.project.create({ key: "NEW" }, actor); } catch { }
  return { legacyReads };
}

test("core reports an unmarked database opened for reading once, and no other state", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, UNMARKED_VERSION);

    expect(withLocation({ home }, legacyReadReport).legacyReads).toEqual([
      { databasePath: databasePath(mainDir), version: UNMARKED_VERSION, latestVersion: latestVersion(MIGRATIONS) },
    ]);
  });

  for (const version of [1, NEWER_VERSION]) {
    withHome((home) => {
      createDatabase(join(home, ".zinn"), version);

      expect(withLocation({ home }, legacyReadReport).legacyReads).toEqual([]);
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

    const outcome = runOpen({ home }, { allowsLegacyRead: true });
    expect(outcome.projects).toEqual([]);
    expect(outcome.writeError!.name).toBe("ReadOnlyDatabaseError");
    expect(readDatabase(mainDir)).toEqual(before);
  });
});

function operationsWalk() {
  const { project, column, task, comment, label, relation } = core;
  const { label: taskLabel, ...taskOperations } = task;
  const objects = { project, column, task: taskOperations, "task.label": taskLabel, comment, label, relation };

  const reads: Record<string, Record<string, () => unknown>> = {
    project: { getById: () => project.getById("p1"), getByKey: () => project.getByKey("APP"), getAll: () => project.getAll(), standardizeKey: () => project.standardizeKey("app") },
    column: { inspect: () => column.inspect({ taskKeys: ["APP-1"] }), getById: () => column.getById("c1"), getAllByProjectKey: () => column.getAllByProjectKey("APP"), getTaskCountsByProjectKey: () => column.getTaskCountsByProjectKey("APP") },
    task: { getAll: () => task.getAll({}), getByKey: () => task.getByKey("APP-1"), search: () => task.search({ query: "First" }), activity: () => task.activity("APP-1") },
    "task.label": { getAll: () => task.label.getAll("APP-1") },
    comment: { getByKey: () => comment.getByKey("APP-1#1"), getAll: () => comment.getAll("APP-1") },
    label: { getAll: () => label.getAll(), getByName: () => label.getByName("bug") },
    relation: { getAll: () => relation.getAll("APP-1") },
  };
  const mutations: Record<string, Record<string, () => unknown>> = {
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
      orderMany: () => task.orderMany({ taskKeys: ["APP-1", "APP-2"], direction: "top" }, actor),
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
      const isListed = key in reads[name]! || key in mutations[name]!;
      if (typeof value === "function" && !isListed) {
        unlisted.push(name + "." + key);
      }
    }
  }

  const outcomes: Record<string, string> = {};
  for (const [name, calls] of Object.entries(mutations)) {
    for (const [key, call] of Object.entries(calls)) {
      try {
        call();
        outcomes[name + "." + key] = "changed";
      } catch (error) {
        assert.ok(error instanceof Error);
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
        assert.ok(error instanceof Error);
        readErrors.push(name + "." + key + ": " + error.message);
      }
    }
  }

  let rawWrite = "written";
  try {
    getDb().exec("INSERT INTO label (id, name, color) VALUES ('l9', 'raw', 'red')");
  } catch (error) {
    assert.ok(error instanceof core.SqliteError);
    rawWrite = error.code;
  }

  return { unlisted, outcomes, readErrors, rawWrite };

}
const MUTATION_COUNT = 27;

test("every core mutation is refused before any SQL runs on a read-only database, while every read works", () => {
  withHome((home) => {
    const mainDir = join(home, ".zinn");
    createDatabase(mainDir, NEWER_VERSION);
    const before = readDatabase(mainDir);
    const result = withLocation({ home }, () => { configureCore({}); return operationsWalk(); });

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
  const actor = { name: "Test Human", email: null, kind: "human" as const };
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
      winner.exec("PRAGMA foreign_keys = OFF");
      winner.exec("BEGIN IMMEDIATE");
      createBaseline(winner);
      applyPendingMigrations(winner, MIGRATIONS, BASELINE_VERSION);

      const child = Bun.spawn(childCommand(location, RACE_INSTRUMENTATION), {
        env: childEnvironment(location),
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = child.stdout.getReader();

      // The winner commits only once the child has found the database empty.
      const seen = await readUntil(reader, "CLASSIFIED empty");
      winner.exec("COMMIT");
      winner.exec("PRAGMA foreign_keys = ON");
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

    expect(readDatabase(mainDir).version).toBe(latestVersion(MIGRATIONS));
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
        cwd: home,
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
    expect(readDatabase(mainDir).version).toBe(latestVersion(MIGRATIONS));
    expect(projectKeys(mainDir)).toEqual(keys);
  });
}, 30_000);
