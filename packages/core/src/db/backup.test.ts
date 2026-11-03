import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Event = { operation: string; path: string; flags?: string };
type Outcome = {
  events: Array<Event>;
  error: string | null;
  suppressed: Array<string>;
  openDescriptors: number;
  before: unknown;
  after: unknown;
  changed: boolean;
};
type Scenario = {
  action?: "backup" | "upgrade" | "restore";
  failure?: "open" | "sync" | "close" | "sync-and-close" | "parent";
  windows?: boolean;
};

const backupModule = fileURLToPath(new URL("./backup.ts", import.meta.url));
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
    const events = [];
    const descriptors = new Map();
    const failure = new Error("injected backup sync failure");
    const closeFailure = new Error("injected close failure");
    let renamed = false;
    let recording = false;
    function fails(path) {
      return scenario.failure === "parent"
        ? path === dirname(backupDirectory)
        : renamed && path === backupDirectory;
    }
    mock.module("node:fs", () => ({
      ...original,
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
        original.renameSync(from, to);
        if (recording) {
          events.push({ operation: "rename", path: resolve(String(to)) });
          renamed = true;
        }
      },
    }));
    if (scenario.windows) {
      Object.defineProperty(process, "platform", { value: "win32" });
    }
    const backup = await import(${JSON.stringify(backupModule)});
    const { seedBaseline, snapshot } = await import(${JSON.stringify(join(migrationsDirectory, "testing.ts"))});
    const { upgradeDatabase } = await import(${JSON.stringify(join(migrationsDirectory, "upgrade.ts"))});
    const { restoreDatabase } = await import(${JSON.stringify(join(migrationsDirectory, "restore.ts"))});
    const databasePath = join(directory, "database.sqlite");
    const db = openDatabase(databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    seedBaseline(db);
    const before = snapshot(db);
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
      } else {
        backup.create(databasePath, backupDirectory, build);
      }
      events.push({ operation: "return", path: backupDirectory });
    } catch (caught) {
      if (caught !== failure && caught !== closeFailure) {
        throw caught;
      }
      error = caught === failure ? "sync" : "close";
      suppressed = caught.suppressed === undefined ? [] : [caught.suppressed === closeFailure ? "close" : "unknown"];
    }
    recording = false;
    const after = snapshot(db);
    db.close();
    console.log(JSON.stringify({ events, error, suppressed, openDescriptors: descriptors.size, before, after, changed }));
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
  const directory = mkdtempSync(join(tmpdir(), "zinn-backup-durability-"));
  const backupDirectory = join(directory, "nested", "backups");
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
        expect(readdirSync(directory)).toHaveLength(failure === "sync" ? 1 : 0);
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
