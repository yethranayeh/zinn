import type { ReleaseMode } from "../release";
import type { DatabaseState } from "./classify";
import type { OpenDecision } from "./open-policy";

import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { decideOpen, isDefaultDatabase } from "./open-policy";
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
      isDefaultDatabase: () => database === "default",
      coreRelease: core,
      clientRelease: client,
      allowsLegacyRead: legacy,
    });

    expect(decision).toEqual(expected);
  },
);

test("only an older database asks whether it is the default database", () => {
  const states: Array<DatabaseState> = ["absent", "empty", "unmarked", "current", "newer"];

  for (const state of states) {
    const isDefaultDatabase = () => {
      throw new Error(`asked for ${state}`);
    };

    expect(() =>
      decideOpen({
        state,
        isDefaultDatabase,
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
