import type { OpenPolicy } from "@zinn-dev/core";
import type { InputForm, PositionalInput } from "./input";

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
  const form = (...positionals: Array<Pick<PositionalInput, "name" | "min" | "max">>): InputForm => ({
    id: "default",
    positionals: positionals.map((positional) => ({ ...positional, value: { kind: "text" } })),
  });
  const projectColumnForm = form(
    { name: "project-key", min: 1, max: 1 },
    { name: "column-name", min: 1, max: 1 },
  );

  expect(() => validatePositionals(["SHOP", "Later"], projectColumnForm)).not.toThrow();
  expect(() => validatePositionals(["SHOP"], projectColumnForm)).toThrow(UsageError);
  expect(() => validatePositionals(["SHOP"], projectColumnForm)).toThrow("<column-name>");
  expect(() => validatePositionals([], projectColumnForm)).toThrow("<project-key>");
  expect(() => validatePositionals(["SHOP", "Needs", "Review", "Now"], projectColumnForm)).toThrow('"Review"');

  // ? min 0 makes a word optional and max null makes it repeat, as [<project-key>] and <task-key>... in usage lines.
  const optionalProjectKey = form({ name: "project-key", min: 0, max: 1 });
  expect(() => validatePositionals([], optionalProjectKey)).not.toThrow();
  expect(() => validatePositionals(["SHOP", "extra"], optionalProjectKey)).toThrow('"extra"');
  expect(() => validatePositionals(["A-1", "A-2", "A-3"], form({ name: "task-key", min: 1, max: null }))).not.toThrow();
  expect(() =>
    validatePositionals(
      ["A-1"],
      form({ name: "task-key", min: 1, max: null }, { name: "target-column", min: 1, max: 1 }),
    ),
  ).toThrow("<target-column>");
});
