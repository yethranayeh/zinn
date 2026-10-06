import type { OpenPolicy } from "@zinn-dev/core";

import { expect, test } from "bun:test";
import { ReadOnlyDatabaseError } from "@zinn-dev/core";

import { failureMessage } from "./lib";

const FALLBACK = "Something went wrong";
const POLICY: OpenPolicy = {
  client: "cli",
  version: "1.0.0",
  executable: "/test/zinn",
  release: "source",
  allowsLegacyRead: false,
};

function readOnlyError(reason: "older" | "newer") {
  const version = reason === "older" ? 1 : 3;
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
