import { expect, test } from "bun:test";
import { editTask } from "../src/inspector/task-actions";
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
