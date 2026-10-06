import type { OpenPolicy } from "@zinn-dev/core";

import { expect, test } from "bun:test";
import { ReadOnlyDatabaseError, UnmarkedDatabaseError } from "@zinn-dev/core";

import { failureMessage } from "./lib";

const FALLBACK = "Something went wrong";
const POLICY: OpenPolicy = {
  client: "cli",
  version: "1.0.0",
  executable: "/test/zinn",
  release: "source",
  allowsLegacyRead: false,
};

function readOnlyError(reason: "older" | "newer" | "unmarked") {
  const versions = { older: 1, newer: 3, unmarked: 0 };
  const version = versions[reason];
  return new ReadOnlyDatabaseError(
    reason,
    { databasePath: "/data/zinn.sqlite", version, latestVersion: 2 },
    POLICY,
  );
}

test("an older database that stays read-only points at zinn migrate in the same line", () => {
  const error = readOnlyError("older");

  expect(failureMessage(error, FALLBACK)).toBe(
    `${error.message}. Run \`zinn migrate\` to upgrade it.`,
  );
});

test("other failures keep their own message, or the fallback when they have none", () => {
  const newer = readOnlyError("newer");

  expect(failureMessage(newer, FALLBACK)).toBe(newer.message);
  expect(failureMessage(new Error("Task does not exist"), FALLBACK)).toBe("Task does not exist");
  expect(failureMessage(undefined, FALLBACK)).toBe(FALLBACK);
});

test("an unmarked database that was not opened names --allow-legacy-read", () => {
  const error = new UnmarkedDatabaseError({
    databasePath: "/data/zinn.sqlite",
    version: 0,
    latestVersion: 2,
  });
  const message = failureMessage(error, FALLBACK);

  expect(message).toStartWith(error.message);
  expect(message).toContain("/data/zinn.sqlite");
  expect(message).toContain("--allow-legacy-read");
});

test("an unmarked database opened for reading refuses changes without pointing at the flag", () => {
  const error = readOnlyError("unmarked");

  expect(failureMessage(error, FALLBACK)).toBe(error.message);
});
