import type { OpenPolicy } from "@zinn-dev/core";

import { expect, test, spyOn } from "bun:test";
import { ReadOnlyDatabaseError, TextEditMatchError, UnmarkedDatabaseError } from "@zinn-dev/core";

import { diagnostic, flushDiagnostics, prepareOutput, setOutputMode, failureMessage, UsageError, validatePositionals } from "./lib";

test("JSON notices wait for completion and text notices remain immediate", () => {
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    prepareOutput(["task", "list", "--json"]);
    diagnostic("waiting");
    diagnostic("finished");
    expect(stderr).not.toHaveBeenCalled();
    flushDiagnostics();
    expect(stderr.mock.calls).toEqual([["waiting"], ["finished"]]);
    flushDiagnostics();
    expect(stderr).toHaveBeenCalledTimes(2);
    prepareOutput(["task", "search", "--", "--json"]);
    diagnostic("text notice");
    expect(stderr.mock.calls.at(-1)).toEqual(["text notice"]);
  } finally {
    setOutputMode("text");
    stderr.mockRestore();
  }
});

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

test("a text edit that matches several places points at --all, and one that matches none does not", () => {
  const several = new TextEditMatchError(3, "ZINN-1's description");
  const none = new TextEditMatchError(0, "ZINN-1's description");

  expect(failureMessage(several, FALLBACK)).toBe(
    `${several.message} Use --all to replace every match.`,
  );
  expect(failureMessage(none, FALLBACK)).toBe(none.message);
});

test("validatePositionals names the first missing word, or the first word past the most it takes", () => {
  const words = ["<project-key>", "<column-name>"];

  expect(() => validatePositionals(["SHOP", "Later"], words)).not.toThrow();
  expect(() => validatePositionals(["SHOP"], words)).toThrow(UsageError);
  expect(() => validatePositionals(["SHOP"], words)).toThrow("<column-name>");
  expect(() => validatePositionals([], words)).toThrow("<project-key>");
  expect(() => validatePositionals(["SHOP", "Needs", "Review", "Now"], words)).toThrow('"Review"');

  // ? Written as in the usage lines: [...] marks an optional word and a trailing ... a word that repeats.
  expect(() => validatePositionals([], ["[<project-key>]"])).not.toThrow();
  expect(() => validatePositionals(["SHOP", "extra"], ["[<project-key>]"])).toThrow('"extra"');
  expect(() => validatePositionals(["A-1", "A-2", "A-3"], ["<task-key>..."])).not.toThrow();
  expect(() => validatePositionals(["A-1"], ["<task-key>...", "<target-column>"])).toThrow("<target-column>");
});
