import type { OpenPolicy } from "@zinn-dev/core";
import type { InputForm, PositionalInput } from "./input";

import { expect, test, spyOn } from "bun:test";
import { ReadOnlyDatabaseError, TextEditMatchError, UnmarkedDatabaseError } from "@zinn-dev/core";
import { parseArgs } from "node:util";

import { boundParserMessage, diagnostic, flushDiagnostics, prepareOutput, setOutputMode, failureMessage, UsageError, validatePositionals, renameFlag, parseArgsMessage } from "./lib";

test("parser repairs stay complete through the message limit and become guidance above it", () => {
  const messageFor = (value: string) => {
    const args = ["task", "create", "SHOP", "--description", value];
    try {
      parseArgs({ args, options: { description: { type: "string" } }, allowPositionals: true });
    } catch (error) {
      return parseArgsMessage(error, args, () => undefined)!;
    }
    throw new Error("Expected a parser refusal");
  };

  const shortValue = "- x";
  const shortMessage = messageFor(shortValue);
  const paddingToLimit = 1024 - shortMessage.length;
  expect(paddingToLimit % 2).toBe(0);
  const atLimitValue = shortValue + "x".repeat(paddingToLimit / 2);
  const atLimitMessage = messageFor(atLimitValue);
  expect(atLimitMessage).toHaveLength(1024);
  expect(atLimitMessage).toContain(`--description='${atLimitValue}'`);

  const belowLimitValue = atLimitValue.slice(0, -1);
  expect(messageFor(belowLimitValue)).toHaveLength(1022);
  expect(messageFor(belowLimitValue)).toContain(`--description='${belowLimitValue}'`);

  const aboveLimitMessage = messageFor(atLimitValue + "x");
  expect(aboveLimitMessage.length).toBeLessThanOrEqual(1024);
  expect(aboveLimitMessage).toContain("--description");
  expect(aboveLimitMessage).toContain("=");
  expect(aboveLimitMessage).toMatch(/omitt/i);
  expect(aboveLimitMessage).not.toContain("zinn task create");
});

test("long usage errors keep complete Unicode at the cutoff and retain structured fields", () => {
  const details = { argument: "direction" };
  for (const prefixLength of [990, 991]) {
    for (const suffix of ["😀", "e\u0301", "👨‍👩‍👧‍👦"]) {
      const failure = new UsageError("x".repeat(prefixLength) + suffix.repeat(100), details);
      expect(failure.message.length).toBeLessThanOrEqual(1024);
      expect(failure.message).toContain("…");
      expect(failure.message.isWellFormed()).toBe(true);
      if (suffix === "e\u0301") {
        expect(failure.message).not.toMatch(/e…/);
      }
      if (suffix === "👨‍👩‍👧‍👦") {
        expect(failure.message).not.toMatch(/👨…/);
      }
      expect(failure.details).toEqual(details);
    }
  }
});

test("bounded parser reasons keep a complete recovery command", () => {
  const command = "zinn task create APP --help";
  const message = boundParserMessage("x".repeat(1300), {
    reason: "e\u0301".repeat(700),
    guidance: `Run ${command}`,
  });
  expect(message.length).toBeLessThanOrEqual(1024);
  expect(message).toContain(command);
  expect(message).not.toMatch(/e…/);
});

test("flag corrections preserve option values and words after the option terminator", () => {
  const args = [
    "--title=--status", "--description", "--status=Done", "--status", "In Progress",
    "--status=Done", "--", "--status", "--status=Done",
  ];
  expect(renameFlag(args, { title: { type: "string" }, description: { type: "string" } }, "status", "column")).toEqual([
    "--title=--status", "--description", "--status=Done", "--column", "In Progress",
    "--column=Done", "--", "--status", "--status=Done",
  ]);
});

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

  const message = failureMessage(error, FALLBACK);
  expect(message).toContain(error.message);
  expect(message).toContain("zinn migrate");
  expect(message).not.toContain("\n");
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

  expect(failureMessage(several, FALLBACK)).toContain(several.message);
  expect(failureMessage(several, FALLBACK)).toContain("--all");
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
