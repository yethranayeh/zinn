import { expect, test } from "bun:test";
import { editTask, readTaskEditOptions } from "../src/inspector/task-actions";
import type { CliReader, CliResult } from "../src/shared/cli";
import type { Settings } from "../src/settings";

const settings: Settings = {
  store: "/synthetic/selected-store", dataDirectory: "/synthetic/state", cli: ["zinn"],
  observe: false, identity: false, captureEffort: false,
};

test("field saves do not preflight or replay a write when completion is uncertain", async () => {
  const calls: string[][] = [];
  let failure: CliResult = { ok: false, error: "Unreadable result" };
  const reader: CliReader = {
    async run<Value>(args: string[]) {
      calls.push(args);
      return failure as CliResult<Value>;
    },
    async close() {},
  };
  const result = await editTask(settings, " app-1 ", {
    title: "- literal title", description: "", priority: null,
  }, reader);
  expect(result).toMatchObject({ kind: "error", key: "APP-1", uncertain: true });
  expect(calls).toEqual([["task", "edit", "APP-1", "--title=- literal title", "--description=", "--priority=none"]]);
  failure = { ok: false, code: "validation", error: "Invalid field" };
  expect(await editTask(settings, "APP-1", { title: "" }, reader)).toMatchObject({
    kind: "error", uncertain: false,
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["task", "edit", "APP-1", "--title="]);
  expect(await editTask(settings, "invalid", { title: "Ignored" }, reader)).toMatchObject({ kind: "error" });
  expect(calls).toHaveLength(2);
});

test("edit options follow configured CLI capabilities and report unavailable metadata without guessing priorities", async () => {
  const calls: string[][] = [];
  const manifest = (value: unknown) => ({
    manifestVersion: 1,
    commands: [{ path: ["task", "edit"], input: { options: { priority: { value } } } }],
  });
  let response: CliResult = { ok: true, value: manifest({ kind: "enum", choices: ["deferred", "critical", "none"] }) };
  const reader: CliReader = {
    async run<Value>(args: string[]) {
      calls.push(args);
      return response as CliResult<Value>;
    },
    async close() {},
  };
  expect(await readTaskEditOptions(reader)).toEqual({ kind: "ready", priorities: ["deferred", "critical"] });
  for (const value of [
    null,
    { manifestVersion: 2, commands: [] },
    { manifestVersion: 1, commands: [] },
    manifest({ kind: "text" }),
    manifest({ kind: "enum", choices: ["critical"] }),
    manifest({ kind: "enum", choices: ["", "none"] }),
  ]) {
    response = { ok: true, value };
    expect(await readTaskEditOptions(reader)).toMatchObject({ kind: "error", error: expect.any(String) });
  }
  response = { ok: false, error: "Configured CLI unavailable" };
  expect(await readTaskEditOptions(reader)).toEqual({ kind: "error", error: "Configured CLI unavailable" });
  expect(calls.every(args => args.length === 1 && args[0] === "capabilities")).toBe(true);
});
