import type { ReleaseMode } from "../release";
import type { DatabaseState } from "./classify";
import type { OpenDecision } from "./open-policy";

import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveStorage } from "../constant";
import { decideOpen, isDefaultDatabase, isProtectedStorage } from "./open-policy";
import { withDirectory } from "./testing";

type Row = {
  state: DatabaseState;
  core: ReleaseMode;
  client: ReleaseMode;
  database: "default" | "isolated";
  legacy?: boolean;
  expected: OpenDecision;
};

const CREATE = { action: "create" } as const;
const WRITE = { action: "write" } as const;
const UPGRADE = { action: "upgrade" } as const;
const REFUSE = { action: "refuse" } as const;
const OLDER_READ_ONLY = { action: "read-only", reason: "older" } as const;
const NEWER_READ_ONLY = { action: "read-only", reason: "newer" } as const;
const UNMARKED_READ_ONLY = { action: "read-only", reason: "unmarked" } as const;

const rows: Array<Row> = [
  { state: "absent", core: "source", client: "source", database: "default", expected: CREATE },
  { state: "empty", core: "published", client: "published", database: "isolated", expected: CREATE },
  { state: "current", core: "source", client: "source", database: "default", expected: WRITE },
  { state: "current", core: "published", client: "published", database: "isolated", expected: WRITE },
  { state: "newer", core: "source", client: "source", database: "default", expected: NEWER_READ_ONLY },
  { state: "newer", core: "published", client: "published", database: "isolated", expected: NEWER_READ_ONLY },
  { state: "unmarked", core: "published", client: "published", database: "isolated", expected: REFUSE },
  { state: "unmarked", core: "source", client: "source", database: "default", legacy: true, expected: UNMARKED_READ_ONLY },
  { state: "older", core: "source", client: "source", database: "default", expected: OLDER_READ_ONLY },
  { state: "older", core: "published", client: "source", database: "default", expected: OLDER_READ_ONLY },
  { state: "older", core: "source", client: "published", database: "default", expected: OLDER_READ_ONLY },
  { state: "older", core: "published", client: "published", database: "default", legacy: true, expected: UPGRADE },
  { state: "older", core: "source", client: "source", database: "isolated", expected: UPGRADE },
  { state: "older", core: "source", client: "published", database: "isolated", expected: UPGRADE },
];

test.each(rows)(
  "$state $database database with core $core and client $client opens as $expected.action",
  ({ state, core, client, database, legacy = false, expected }) => {
    const decision = decideOpen({
      state,
      isProtectedDatabase: () => database === "default",
      coreRelease: core,
      clientRelease: client,
      allowsLegacyRead: legacy,
    });

    expect(decision).toEqual(expected);
  },
);

test("only an older database asks whether it is a protected database", () => {
  const states: Array<DatabaseState> = ["absent", "empty", "unmarked", "current", "newer"];

  for (const state of states) {
    const isProtectedDatabase = () => {
      throw new Error(`asked for ${state}`);
    };

    expect(() =>
      decideOpen({
        state,
        isProtectedDatabase,
        coreRelease: "source",
        clientRelease: "source",
        allowsLegacyRead: true,
      }),
    ).not.toThrow();
  }
});

test("a folder holds the default database when it reaches the default folder by the same path, a link or a parent step", () => {
  withDirectory((home) => {
    const defaultDir = join(home, ".zinn");
    const other = join(home, "other");
    const link = join(home, "link");
    mkdirSync(defaultDir);
    mkdirSync(other);
    symlinkSync(defaultDir, link);

    expect(isDefaultDatabase(defaultDir, defaultDir)).toBe(true);
    expect(isDefaultDatabase(link, defaultDir)).toBe(true);
    expect(isDefaultDatabase(join(other, "..", ".zinn"), defaultDir)).toBe(true);
    expect(isDefaultDatabase(other, defaultDir)).toBe(false);
  });
});

test("without the default folder, another folder does not hold the default database", () => {
  withDirectory((home) => {
    const other = join(home, "other");
    mkdirSync(other);

    expect(isDefaultDatabase(other, join(home, ".zinn"))).toBe(false);
  });
});

test("a ZINN_DIR below a regular file counts as missing, so it does not hold the default database", () => {
  withDirectory((home) => {
    const defaultDir = join(home, ".zinn");
    const file = join(home, "file");
    const belowFile = join(file, "zinn");
    mkdirSync(defaultDir);
    writeFileSync(file, "not a folder");
    let code: unknown;
    try {
      realpathSync(belowFile);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }

    expect(code).toBe("ENOTDIR");
    expect(isDefaultDatabase(belowFile, defaultDir)).toBe(false);
    expect(isProtectedStorage(resolveStorage({ cwd: home, env: { ZINN_DIR: belowFile }, home }))).toBe(false);
  });
});

test("a default store is protected, even before its folder exists", () => {
  withDirectory((home) => {
    expect(isProtectedStorage(resolveStorage({ cwd: home, env: {}, home }))).toBe(true);
  });
});

test("a ZINN_DIR store is protected only when it reaches the default folder", () => {
  withDirectory((home) => {
    const defaultDir = join(home, ".zinn");
    const other = join(home, "other");
    const link = join(home, "link");
    mkdirSync(defaultDir);
    mkdirSync(other);
    symlinkSync(defaultDir, link);
    const isProtected = (zinnDir: string) =>
      isProtectedStorage(resolveStorage({ cwd: home, env: { ZINN_DIR: zinnDir }, home }));

    expect(isProtected(defaultDir)).toBe(true);
    expect(isProtected(link)).toBe(true);
    expect(isProtected(other)).toBe(false);
  });
});

test("a store chosen by either settings file is protected, outside the default folder too", () => {
  withDirectory((root) => {
    const home = join(root, "home");
    const repository = join(root, "repository");
    mkdirSync(join(home, ".zinn"), { recursive: true });
    mkdirSync(join(repository, ".git"), { recursive: true });
    writeFileSync(join(home, ".zinn", "settings.json"), JSON.stringify({ storage: { directory: join(root, "global-store") } }));

    const globalStorage = resolveStorage({ cwd: repository, env: {}, home });
    expect(globalStorage.source).toBe("global");
    expect(isProtectedStorage(globalStorage)).toBe(true);

    writeFileSync(join(repository, "zinn.local.json"), JSON.stringify({ storage: { directory: "local-store" } }));

    const localStorage = resolveStorage({ cwd: repository, env: {}, home });
    expect(localStorage.source).toBe("local");
    expect(isProtectedStorage(localStorage)).toBe(true);
  });
});
