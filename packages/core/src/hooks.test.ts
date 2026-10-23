import { spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activity, project, relation, task } from "../index";
import { withEnvironment, withTestStore } from "./testing";

const human = { name: "Test Human", email: "human@example.com", kind: "human" as const };
const LARGER_THAN_PIPE_BUFFER = 200_000;
const SLOW_HOOK_SECONDS = 5;
const SLOW_HOOK_TIMEOUT_SECONDS = 0.3;
// Well under the slow hooks' sleep, so waiting on one fails the check.
const HOOK_CHANGE_LIMIT_MS = 4_000;
// Not a whole number of milliseconds once converted.
const FRACTIONAL_TIMEOUT_SECONDS = 2.01;

/** A hook that appends its name, stdin, working folder and ZINN_HOOKS to files in `logs`. */
function recordingHook(logs: string, name: string) {
  const file = (suffix: string) => `'${join(logs, `${name}.${suffix}`)}'`;
  return {
    command: `cat >> ${file("stdin")}; pwd >> ${file("cwd")}; printf '%s\\n' "$ZINN_HOOKS" >> ${file("env")}; echo ${name} >> '${join(logs, "order")}'`,
  };
}

function writeHooks(directory: string, hooks: Record<string, { command: string; timeout?: number }>) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ hooks }));
}

function readLines(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : [];
}

/** A store with hooks, a logs folder and a caller folder that is not the store. */
function withHookStore(
  hooks: (logs: string) => Record<string, { command: string; timeout?: number }>,
  check: (context: { logs: string; caller: string; runs: () => Array<string> }) => void,
  environment: Record<string, string | undefined> = {},
) {
  withTestStore((directory) => {
    const logs = join(directory, "logs");
    const caller = join(directory, "caller");
    mkdirSync(logs);
    mkdirSync(caller);
    writeHooks(directory, hooks(logs));
    withEnvironment({ ZINN_DIR: directory, ...environment }, () => check({ logs, caller, runs: () => readLines(join(logs, "order")) }), caller);
  });
}

test("ZINN-161: each hook runs once per change in settings order, in the caller's folder, with the change's records", () => {
  withHookStore((logs) => ({ second: recordingHook(logs, "second"), first: recordingHook(logs, "first") }), ({ logs, caller, runs }) => {
    const app = project.create({ key: "APP" }, human);
    assert.deepEqual(runs(), ["second", "first"]);

    const projectLines = readLines(join(logs, "first.stdin")).map((line) => JSON.parse(line));
    assert.deepEqual(projectLines, activity.getAll().map((record) => ({ ...record, task_key: null })));

    const target = task.create({ project_id: app.id, title: "Target" }, human);
    const source = task.create({ project_id: app.id, title: "Source" }, human);
    writeFileSync(join(logs, "first.stdin"), "");
    relation.create({ sourceTaskKey: source.key, targetTaskKey: target.key, relation_type: "dependency" }, human);

    const relationLines = readLines(join(logs, "first.stdin")).map((line) => JSON.parse(line));
    const stored = new Map(activity.getAll().map((record) => [record.id, record]));
    assert.equal(relationLines.length, 2);
    for (const line of relationLines) {
      const { task_key, ...record } = line;
      assert.deepEqual(record, stored.get(line.id));
      assert.equal(task_key, line.entity_id === source.id ? source.key : target.key);
    }

    assert.deepEqual(runs(), ["second", "first", "second", "first", "second", "first", "second", "first"]);
    assert.deepEqual(new Set(readLines(join(logs, "first.cwd"))), new Set([realpathSync(caller)]));
    assert.deepEqual(new Set(readLines(join(logs, "first.env"))), new Set(["0"]));
  });
});

test("ZINN-161: a nested write runs hooks once, a no-op runs none, and a deleted task keeps its key", () => {
  withHookStore((logs) => ({ only: recordingHook(logs, "only") }), ({ logs, runs }) => {
    const app = project.create({ key: "APP" }, human);
    const target = task.create({ project_id: app.id, title: "Target" }, human);
    writeFileSync(join(logs, "only.stdin"), "");
    const source = task.create({ project_id: app.id, title: "Source", relations: [{ relation_type: "related", targetTaskKey: target.key }] }, human);
    assert.equal(runs().length, 3);
    assert.deepEqual(readLines(join(logs, "only.stdin")).map((line) => JSON.parse(line).task_key).sort(), [source.key, source.key, target.key].sort());

    task.edit({ taskKey: source.key, title: "Source" }, human);
    assert.equal(runs().length, 3);

    writeFileSync(join(logs, "only.stdin"), "");
    task.delete(target.key, human);
    const deleteLines = readLines(join(logs, "only.stdin")).map((line) => JSON.parse(line));
    assert.deepEqual(deleteLines.map((line) => [line.action, line.task_key]), [["relation_delete", source.key], ["delete", target.key]]);
  });
});

test("ZINN-161: ZINN_HOOKS=0 saves changes without running hooks", () => {
  withHookStore((logs) => ({ only: recordingHook(logs, "only") }), ({ runs }) => {
    project.create({ key: "APP" }, human);
    assert.deepEqual(runs(), []);
    assert.equal(project.getAll().length, 1);
  }, { ZINN_HOOKS: "0" });
});

test("ZINN-161: a failing or slow hook warns with its name and the change stays saved", () => {
  withHookStore(() => ({ failing: { command: "exit 3" }, slow: { command: `trap '' TERM; sleep ${SLOW_HOOK_SECONDS}`, timeout: SLOW_HOOK_TIMEOUT_SECONDS }, quiet: { command: "true" } }), () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const started = Date.now();
      project.create({ key: "APP" }, human);
      assert.ok(Date.now() - started < HOOK_CHANGE_LIMIT_MS);
      const warnings = stderr.mock.calls.map(([text]) => String(text));
      assert.equal(warnings.length, 2);
      assert.match(warnings[0]!, /"failing"/);
      assert.match(warnings[1]!, /"slow"/);
    } finally {
      stderr.mockRestore();
    }
    assert.equal(project.getAll().length, 1);
  });
});

test("ZINN-161: a timeout that is not a whole number of milliseconds still runs the hook", () => {
  withHookStore((logs) => ({ only: { ...recordingHook(logs, "only"), timeout: FRACTIONAL_TIMEOUT_SECONDS } }), ({ runs }) => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      project.create({ key: "APP" }, human);
      assert.deepEqual(stderr.mock.calls, []);
    } finally {
      stderr.mockRestore();
    }
    assert.deepEqual(runs(), ["only"]);
  });
});

test("ZINN-161: a hook that ignores a large stdin, or leaves a child running, returns quietly", () => {
  withHookStore((logs) => ({ ignoring: { command: "exit 0" }, detaching: { command: `(sleep ${SLOW_HOOK_SECONDS}; touch '${join(logs, "late")}') >/dev/null 2>&1 &` } }), ({ logs }) => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const app = project.create({ key: "APP" }, human);
      const started = Date.now();
      task.create({ project_id: app.id, title: "Large", description: "x".repeat(LARGER_THAN_PIPE_BUFFER) }, human);
      assert.ok(Date.now() - started < HOOK_CHANGE_LIMIT_MS);
      assert.deepEqual(stderr.mock.calls, []);
      assert.equal(existsSync(join(logs, "late")), false);
    } finally {
      stderr.mockRestore();
    }
  });
});
