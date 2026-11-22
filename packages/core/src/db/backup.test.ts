import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Event = { operation: string; path: string; flags?: string };
type Outcome = {
  events: Array<Event>;
  error: string | null;
  errorBackupPath: string | null;
  sourceExists: boolean;
  suppressed: Array<string>;
  openDescriptors: number;
  before: unknown;
  after: unknown;
  changed: boolean;
};
type Scenario = {
  action?: "backup" | "upgrade" | "restore";
  failure?: "open" | "sync" | "close" | "sync-and-close" | "parent" | "rename" | "rename-and-cleanup" | "source-removed";
  windows?: boolean;
};

const backupModule = fileURLToPath(new URL("./backup.ts", import.meta.url));
const backupOperation = fileURLToPath(new URL("../operations/backup.ts", import.meta.url));
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const DIRECTORY_SYNC_SUPPORTED = process.platform !== "win32";

/** Each child owns its filesystem mocks, so the suite's other tests use the real module. */
async function runScenario(directory: string, backupDirectory: string, scenario: Scenario) {
  const child = Bun.spawn([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import { dirname, join, resolve } from "node:path";
    import { openDatabase } from "#sqlite";
    const original = { ...fs };
    const directory = ${JSON.stringify(directory)};
    const backupDirectory = ${JSON.stringify(backupDirectory)};
    const scenario = ${JSON.stringify(scenario)};
    const databasePath = join(directory, "data", "zinn.sqlite");
    const events = [];
    const descriptors = new Map();
    const failure = new Error("injected backup sync failure");
    const closeFailure = new Error("injected close failure");
    const renameFailure = new Error("injected rename failure");
    const cleanupFailure = new Error("injected partial cleanup failure");
    let renamed = false;
    let recording = false;
    function fails(path) {
      return scenario.failure === "parent"
        ? path === dirname(backupDirectory)
        : renamed && path === backupDirectory;
    }
    mock.module("node:fs", () => ({
      ...original,
      mkdirSync(path, options) {
        if (recording && scenario.failure === "source-removed" && path === backupDirectory) {
          original.unlinkSync(databasePath);
        }
        return original.mkdirSync(path, options);
      },
      openSync(path, flags, mode) {
        const name = resolve(String(path));
        if (recording && scenario.failure === "open" && fails(name)) {
          throw failure;
        }
        const fd = original.openSync(path, flags, mode);
        if (recording) {
          descriptors.set(fd, name);
          events.push({ operation: "open", path: name, flags });
        }
        return fd;
      },
      fsyncSync(fd) {
        const path = descriptors.get(fd);
        if (recording) {
          events.push({ operation: "sync", path });
          if (fails(path) && ["sync", "sync-and-close", "parent"].includes(scenario.failure)) {
            throw failure;
          }
        }
        return original.fsyncSync(fd);
      },
      closeSync(fd) {
        const path = descriptors.get(fd);
        original.closeSync(fd);
        descriptors.delete(fd);
        if (recording) {
          events.push({ operation: "close", path });
          if (fails(path) && ["close", "sync-and-close"].includes(scenario.failure)) {
            throw closeFailure;
          }
        }
      },
      renameSync(from, to) {
        if (recording && ["rename", "rename-and-cleanup"].includes(scenario.failure)) {
          throw renameFailure;
        }
        original.renameSync(from, to);
        if (recording) {
          events.push({ operation: "rename", path: resolve(String(to)) });
          renamed = true;
        }
      },
      rmSync(path, options) {
        if (recording && scenario.failure === "rename-and-cleanup" && String(path).endsWith(".partial")) {
          throw cleanupFailure;
        }
        return original.rmSync(path, options);
      },
    }));
    if (scenario.windows) {
      Object.defineProperty(process, "platform", { value: "win32" });
    }
    const backup = await import(${JSON.stringify(backupModule)});
    const { backup: backupOperations } = await import(${JSON.stringify(backupOperation)});
    const { seedBaseline, snapshot } = await import(${JSON.stringify(join(migrationsDirectory, "testing.ts"))});
    const { upgradeDatabase } = await import(${JSON.stringify(join(migrationsDirectory, "upgrade.ts"))});
    const { restoreDatabase } = await import(${JSON.stringify(join(migrationsDirectory, "restore.ts"))});
    original.mkdirSync(dirname(databasePath));
    const db = openDatabase(databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    seedBaseline(db);
    const before = snapshot(db);
    const removesSource = scenario.failure === "source-removed";
    if (removesSource) {
      db.close();
    }
    let source;
    if (scenario.action === "restore") {
      source = join(directory, "source.sqlite");
      const sourceDb = openDatabase(source);
      seedBaseline(sourceDb);
      sourceDb.exec("UPDATE task SET title = 'Restored title'");
      sourceDb.close();
    }
    const build = { directory: backupDirectory, client: "test", version: "1.2.3" };
    const readFreeSpace = () => ({ availableBytes: 2 ** 40, blockBytes: 4096, device: 1 });
    let error = null;
    let errorBackupPath = null;
    let suppressed = [];
    let changed = false;
    recording = true;
    try {
      if (scenario.action === "upgrade") {
        const result = upgradeDatabase(db, {
          backup: build,
          readFreeSpace,
          migrations: [{
            version: 2, name: "backup durability check", rebuilds: [],
            apply(connection) { connection.exec("UPDATE task SET title = 'Upgraded title'"); },
          }],
        });
        changed = result.changed;
      } else if (scenario.action === "restore") {
        restoreDatabase(databasePath, source, { backup: build, readFreeSpace, migrations: [] });
        changed = true;
      } else if (removesSource) {
        backupOperations.create(build);
      } else {
        backup.create(databasePath, backupDirectory, build);
      }
      events.push({ operation: "return", path: backupDirectory });
    } catch (caught) {
      let cause = caught;
      if (caught instanceof backup.BackupDirectorySyncError) {
        if (caught.kind !== "storage" || caught.facts.entity !== "backup") {
          throw caught;
        }
        errorBackupPath = caught.facts.backupPath;
        cause = caught.cause;
      }
      if (cause === failure) {
        error = "sync";
      } else if (cause === closeFailure) {
        error = "close";
      } else if (cause === renameFailure) {
        error = "rename";
      } else if (removesSource && caught.code === "SQLITE_CANTOPEN") {
        error = caught.code;
      } else {
        throw caught;
      }
      if (cause.suppressed !== undefined) {
        const suppressedFailures = new Map([[closeFailure, "close"], [cleanupFailure, "cleanup"]]);
        suppressed = [suppressedFailures.get(cause.suppressed) ?? "unknown"];
      }
    }
    recording = false;
    const sourceExists = original.existsSync(databasePath);
    const after = removesSource ? null : snapshot(db);
    if (!removesSource) {
      db.close();
    }
    console.log(JSON.stringify({ events, error, errorBackupPath, sourceExists, suppressed, openDescriptors: descriptors.size, before, after, changed }));
  `], {
    cwd: dirname(backupModule),
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ZINN_DIR: directory, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout) as Outcome;
}

async function withScenario(
  scenario: Scenario,
  check: (outcome: Outcome, backupDirectory: string) => void,
  existing = false,
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zinn-backup-durability-")));
  const backupDirectory = scenario.failure === "source-removed"
    ? join(directory, "backups")
    : join(directory, "nested", "backups");
  try {
    if (existing) {
      mkdirSync(backupDirectory, { recursive: true });
    }
    const outcome = await runScenario(directory, backupDirectory, scenario);
    check(outcome, backupDirectory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectSynced(outcome: Outcome, backupDirectory: string) {
  expect(outcome.error).toBeNull();
  expect(outcome.openDescriptors).toBe(0);
  const rename = outcome.events.findIndex((event) => event.operation === "rename");
  expect(rename).toBeGreaterThan(0);
  const path = outcome.events[rename]!.path;
  expect(outcome.events.slice(0, rename)).toContainEqual({ operation: "sync", path: path + ".partial" });
  const returned = outcome.events.findIndex((event) => event.operation === "return");
  const directorySync = outcome.events.findIndex((event, index) =>
    index > rename && event.operation === "sync" && event.path === backupDirectory);
  expect(directorySync).toBeGreaterThan(rename);
  expect(directorySync).toBeLessThan(returned);
  expect(outcome.events.slice(directorySync + 1, returned)).toContainEqual({ operation: "close", path: backupDirectory });
  let parent = dirname(backupDirectory);
  for (;;) {
    expect(outcome.events.slice(0, returned)).toContainEqual({ operation: "sync", path: parent });
    const ancestor = dirname(parent);
    if (ancestor === parent) {
      break;
    }
    parent = ancestor;
  }
}

test.skipIf(!DIRECTORY_SYNC_SUPPORTED)("backup syncs the file before rename and its directory before returning, including new parent entries", async () => {
  await withScenario({}, expectSynced);
});

test.skipIf(!DIRECTORY_SYNC_SUPPORTED)("backup syncs existing parent entries left by other attempts", async () => {
  await withScenario({}, expectSynced, true);
});

test("backup fails without recreating a source removed after classification", async () => {
  await withScenario({ failure: "source-removed" }, (outcome, directory) => {
    expect(outcome.error).toBe("SQLITE_CANTOPEN");
    expect(outcome.sourceExists).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });
});

test("a failed rename removes the partial snapshot and preserves the rename error", async () => {
  await withScenario({ failure: "rename" }, (outcome, directory) => {
    expect(outcome.error).toBe("rename");
    expect(outcome.errorBackupPath).toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });
});

test("a failed partial cleanup is suppressed on the rename error", async () => {
  await withScenario({ failure: "rename-and-cleanup" }, (outcome, directory) => {
    expect(outcome.error).toBe("rename");
    expect(outcome.suppressed).toEqual(["cleanup"]);
    expect(readdirSync(directory)).toEqual([expect.stringMatching(/\.sqlite\.partial$/)]);
  });
});

for (const failure of ["open", "sync", "close", "sync-and-close"] as const) {
  test.skipIf(!DIRECTORY_SYNC_SUPPORTED)(`a directory ${failure} failure retains the completed backup and closes its descriptor`, async () => {
    await withScenario({ failure }, (outcome, directory) => {
      expect(outcome.error).toBe(failure === "close" ? "close" : "sync");
      expect(outcome.suppressed).toEqual(failure === "sync-and-close" ? ["close"] : []);
      expect(outcome.openDescriptors).toBe(0);
      expect(outcome.events.some((event) => event.operation === "return")).toBe(false);
      const saved = readdirSync(directory);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.endsWith(".sqlite")).toBe(true);
      expect(outcome.errorBackupPath).toBe(join(directory, saved[0]!));
      expect(outcome.after).toEqual(outcome.before);
    });
  });
}

for (const action of ["upgrade", "restore"] as const) {
  test.skipIf(!DIRECTORY_SYNC_SUPPORTED)(`${action} syncs a newly created backup directory before changing the database`, async () => {
    await withScenario({ action }, (outcome, directory) => {
      expectSynced(outcome, directory);
      expect(outcome.changed).toBe(true);
      expect(outcome.after).not.toEqual(outcome.before);
    });
  });

  for (const failure of ["sync", "parent"] as const) {
    test.skipIf(!DIRECTORY_SYNC_SUPPORTED)(`${action} leaves the database unchanged on a ${failure} sync failure`, async () => {
      await withScenario({ action, failure }, (outcome, directory) => {
        expect(outcome.error).toBe("sync");
        expect(outcome.openDescriptors).toBe(0);
        expect(outcome.changed).toBe(false);
        expect(outcome.after).toEqual(outcome.before);
        if (failure === "parent") {
          expect(readdirSync(directory)).toEqual([]);
          expect(outcome.errorBackupPath).toBeNull();
        } else {
          const files = readdirSync(directory);
          expect(files).toEqual([expect.stringMatching(/\.sqlite$/)]);
          expect(outcome.errorBackupPath).toBe(join(directory, files[0]!));
        }
      });
    });
  }
}

test("the Windows branch keeps syncing backup contents and skips directory descriptors", async () => {
  await withScenario({ windows: true }, (outcome) => {
    expect(outcome.error).toBeNull();
    expect(outcome.openDescriptors).toBe(0);
    const opened = outcome.events.filter((event) => event.operation === "open");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.flags).toBe("r+");
    expect(opened[0]!.path.endsWith(".partial")).toBe(true);
    expect(outcome.events).toContainEqual({ operation: "sync", path: opened[0]!.path });
    expect(outcome.events.at(-1)!.operation).toBe("return");
  });
});
