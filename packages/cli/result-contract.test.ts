import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Ajv from "ajv";
import { Database } from "bun:sqlite";
import { runCli, runCliInTerminal } from "./testing";
import { parseRoutes } from "./src/routes/router";
import { routes } from "./src/routes/routes";
import { generateResultSchemas, type ResultSchemaName } from "./src/result-schemas";
import type { ParsedRoute } from "./src/types";
import { createBaseline } from "../core/src/migrations/baseline";
import { openDatabase } from "../core/src/sqlite/bun";

const root = mkdtempSync(join(tmpdir(), "zinn-result-contract-"));
const seed = join(root, "seed");
const commands = parseRoutes(routes);
const document = generateResultSchemas();
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
ajv.addSchema(document, "results");
let backupPath: string;
let commentKey: string;
let eventId: string;

function invoke(directory: string, args: string[]) {
  return runCli([...args, "--json"], {
    cwd: root,
    env: { ...process.env, ZINN_DIR: directory, AI_AGENT: "contract-test", FORCE_COLOR: "0", ZINN_DEBUG: undefined, DEBUG: undefined },
  });
}
function success(directory: string, args: string[]) {
  const result = invoke(directory, args);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function fixtureDirectory(empty = false) {
  const directory = mkdtempSync(join(root, "case-"));
  if (!empty) {
    mkdirSync(join(directory, "data"));
    copyFileSync(backupPath, join(directory, "data", "zinn.sqlite"));
  }
  return directory;
}
function editFixture(directory: string, sql: string) {
  const db = new Database(join(directory, "data", "zinn.sqlite"));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

beforeAll(() => {
  success(seed, ["project", "create", "APP"]);
  success(seed, ["label", "create", "bug", "--color", "red"]);
  success(seed, ["task", "create", "APP", "--title", "Alpha", "--label", "bug"]);
  success(seed, ["task", "create", "APP", "--title", "Beta", "--priority", "high", "--description", "Details"]);
  commentKey = success(seed, ["task", "comment", "create", "APP-1", "--text", "A comment"]).key;
  success(seed, ["task", "relation", "create", "APP-1", "APP-2", "--type", "dependency"]);
  success(seed, ["task", "order", "APP-1", "bottom"]);
  eventId = success(seed, ["activity", "list"])[0].id;
  backupPath = success(seed, ["backup"]).path;
}, 15000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Fixture = {
  schema: ResultSchemaName;
  args: string[];
  empty?: boolean;
  prepare?: (directory: string) => void;
  check?: (value: any) => void;
};

const fixtures: Record<string, Fixture[]> = {
  "capabilities": [{ schema: "Capabilities", args: [] }],
  "project create": [{ schema: "Project", args: ["NEW"] }],
  "project list": [{ schema: "ProjectList", args: [] }, { schema: "ProjectList", args: [], empty: true }],
  "project view": [{ schema: "ProjectView", args: ["APP"] }],
  "project edit": [{ schema: "Project", args: ["APP", "--name", "Renamed"] }],
  "project delete": [{ schema: "Project", args: ["APP", "--yes"] }],
  "project column create": [{ schema: "Column", args: ["APP", "New column"] }],
  "project column list": [{ schema: "ColumnList", args: ["APP"] }],
  "project column edit": [{ schema: "Column", args: ["APP", "Backlog", "--name", "Ideas"] }],
  "project column order": [{ schema: "Column", args: ["APP", "Backlog", "last"] }],
  "task create": [{ schema: "Task", args: ["APP", "--title", "New task"] }],
  "task list": [{ schema: "TaskList", args: ["APP"] }, { schema: "TaskList", args: ["APP", "--column", "Absent"] }],
  "task search": [{ schema: "TaskList", args: ["Alpha", "APP"] }, { schema: "TaskList", args: ["Unmatched"] }],
  "task view": [
    { schema: "TaskDetail", args: ["APP-1"], check: (value) => expect(Object.hasOwn(value, "activity")).toBe(false) },
    { schema: "TaskDetailHistory", args: ["APP-1", "--history"], check: (value) => expect(value.activity.length).toBeGreaterThan(0) },
    { schema: "TaskDetailHistory", args: ["APP-1", "--history"], prepare: (dir) => editFixture(dir, "DELETE FROM activity"), check: (value) => expect(value.activity).toEqual([]) },
  ],
  "task edit": [{ schema: "Task", args: ["APP-1", "--title", "Edited"] }, { schema: "Task", args: ["APP-1", "--title", "Alpha"] }],
  "task move": [
    { schema: "TaskChange", args: ["APP-1", "Done"], check: (v) => expect(v.changed).toBe(true) },
    { schema: "TaskChange", args: ["APP-1", "Backlog"], check: (v) => expect(v.changed).toBe(false) },
    { schema: "TaskChanges", args: ["APP-1", "APP-2", "Done"] },
    { schema: "TaskChanges", args: ["APP-1", "APP-1", "Done"], check: (v) => { expect(v).toHaveLength(2); expect(v.map((x: any) => x.key)).toEqual(["APP-1", "APP-1"]); } },
  ],
  "task order": [{ schema: "Task", args: ["APP-1", "top"] }],
  "task archive": [
    { schema: "TaskChange", args: ["APP-1"] },
    { schema: "TaskChanges", args: ["APP-1", "APP-2"] },
    { schema: "TaskChanges", args: ["APP-1", "APP-1"] },
    { schema: "TaskChange", args: ["APP-1"], prepare: (dir) => { success(dir, ["task", "archive", "APP-1"]); }, check: (v) => expect(v.changed).toBe(false) },
  ],
  "task unarchive": [
    { schema: "TaskChange", args: ["APP-1"], check: (v) => expect(v.changed).toBe(false) },
    { schema: "TaskChange", args: ["APP-1"], prepare: (dir) => { success(dir, ["task", "archive", "APP-1"]); }, check: (v) => expect(v.changed).toBe(true) },
    { schema: "TaskChanges", args: ["APP-1", "APP-2"] },
    { schema: "TaskChanges", args: ["APP-1", "APP-1"] },
  ],
  "task delete": [{ schema: "Task", args: ["APP-1", "--yes"] }],
  "task label add": [{ schema: "Task", args: ["APP-2", "bug"] }],
  "task label remove": [{ schema: "Task", args: ["APP-1", "bug"] }],
  "task relation create": [{ schema: "RelationChange", args: ["APP-1", "APP-2", "--type", "related"] }],
  "task relation list": [{ schema: "RelationList", args: ["APP-1"] }],
  "task relation delete": [{ schema: "RelationChange", args: ["APP-1", "APP-2", "--type", "dependency"] }],
  "task comment create": [{ schema: "Comment", args: ["APP-1", "--text", "Another comment"] }],
  "task comment list": [{ schema: "CommentList", args: ["APP-1"] }, { schema: "CommentList", args: ["APP-2"] }],
  "task comment view": [{ schema: "Comment", args: ["$comment"] }],
  "task comment edit": [{ schema: "Comment", args: ["$comment", "--text", "Edited"] }],
  "task comment delete": [{ schema: "Comment", args: ["$comment", "--yes"] }],
  "label create": [{ schema: "Label", args: ["new-label", "--color", "blue"] }],
  "label list": [{ schema: "LabelList", args: [] }, { schema: "LabelList", args: [], empty: true }],
  "label edit": [{ schema: "Label", args: ["bug", "--color", "green"] }],
  "label delete": [{ schema: "Label", args: ["bug", "--yes"] }],
  "activity list": [{ schema: "ActivityList", args: [] }, { schema: "ActivityList", args: ["--task", "APP-999"] }],
  "activity view": [{ schema: "Activity", args: ["$event"] }],
  "backup": [{ schema: "Backup", args: [] }],
  "restore": [
    { schema: "Restore", args: ["$backup", "--yes"], check: (v) => expect(typeof v.backupPath).toBe("string") },
    { schema: "Restore", args: ["$backup", "--yes"], empty: true, check: (v) => { expect(v.previousVersion).toBe(0); expect(v.backupPath).toBeNull(); } },
  ],
  "migrate": [
    { schema: "Migrate", args: [], check: (v) => { expect(v.changed).toBe(false); expect(v.backupPath).toBeNull(); } },
    { schema: "Migrate", args: [], empty: true, prepare: (dir) => {
      mkdirSync(join(dir, "data"));
      const db = openDatabase(join(dir, "data", "zinn.sqlite"));
      try { createBaseline(db); db.exec("PRAGMA user_version = 1"); } finally { db.close(); }
    }, check: (v) => { expect(v.changed).toBe(true); expect(typeof v.backupPath).toBe("string"); } },
  ],
  "reindex": [{ schema: "Reindex", args: [] }],
  "info": [
    { schema: "Info", args: [] },
    { schema: "Info", args: [], empty: true },
    { schema: "Info", args: [], prepare: (dir) => writeFileSync(join(dir, "settings.json"), "{"), check: (v) => expect(v.settingsFiles.some((file: any) => file.state === "error")).toBe(true) },
    { schema: "Info", args: [], prepare: (dir) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProject: "APP", storage: { directory: "unused" } })) },
    { schema: "Info", args: [], prepare: (dir) => writeFileSync(join(dir, "data", "zinn.sqlite"), "not a database"), check: (v) => expect(v.database.error).not.toBeNull() },
  ],
};

function selectResult(route: ParsedRoute, args: string[]) {
  const { values, positionals } = parseArgs({ args, options: route.input.options, allowPositionals: true });
  const selected = route.results.filter(({ selector }) => {
    if (selector.kind === "always") {
      return true;
    }
    if (selector.kind === "booleanOption") {
      return (values[selector.name] === true) === selector.value;
    }
    const form = route.input.forms[0]!;
    const index = form.positionals.findIndex((positional) => positional.name === selector.name);
    expect(index).toBeGreaterThanOrEqual(0);
    const count = positionals.length - (form.positionals.length - 1);
    return count >= selector.min && (selector.max === null || count <= selector.max);
  });
  expect(selected).toHaveLength(1);
  return selected[0]!;
}

test("execution fixtures cover exactly every declared route and result variant", () => {
  expect(Object.keys(fixtures).sort()).toEqual(commands.map((route) => route.command).sort());
  for (const route of commands) {
    expect(route.results.length).toBeGreaterThan(0);
    const expected = route.results.map((result) => JSON.stringify(result)).sort();
    const actual = [...new Set(fixtures[route.command]!.map((fixture) => {
      const result = selectResult(route, fixture.args);
      expect(result.schemaRef).toBe(`#/schemas/definitions/${fixture.schema}`);
      return JSON.stringify(result);
    }))].sort();
    expect(actual).toEqual(expected);
  }
});

for (const route of commands) {
  for (const [index, fixture] of (fixtures[route.command] ?? []).entries()) {
    test(`${route.command}: ${fixture.schema} wire result ${index + 1}`, () => {
      const directory = fixtureDirectory(fixture.empty);
      fixture.prepare?.(directory);
      const replacements: Record<string, string> = { $comment: commentKey, $event: eventId, $backup: backupPath };
      const args = fixture.args.map((arg) => replacements[arg] ?? arg);
      const descriptor = selectResult(route, args);
      const result = invoke(directory, [...route.command.split(" "), ...args]);
      expect(result.code, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      const ref = descriptor.schemaRef.replace("#/schemas/", "results#/");
      const validate = ajv.getSchema(ref)!;
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      fixture.check?.(value);
      const item = Array.isArray(value) ? value[0] : value;
      if (item !== undefined && item !== null) {
        const replaceItem = (replacement: unknown) => Array.isArray(value) ? [replacement, ...value.slice(1)] : replacement;
        expect(validate(replaceItem({ ...item, unexpectedProperty: true }))).toBe(false);
        for (const field of Object.keys(item)) {
          const omitted = { ...item };
          delete omitted[field];
          expect(validate(replaceItem(omitted)), field).toBe(false);
        }
      }
    });
  }
}

test("confirmation refusals and representative failures use the shared error schema", () => {
  const directory = fixtureDirectory();
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultProject: "APP" }));
  for (const args of [
    ["task", "delete", "APP-1"], ["project", "delete", "APP",],
    ["project", "delete", "--yes"], ["label", "delete", "bug"],
    ["task", "comment", "delete", commentKey], ["restore", backupPath],
    ["task", "view", "APP-999"], ["task", "create", "APP", "--title", "X", "--priority", "wrong"],
    ["task", "view", "--unknown"], ["migrate", "extra"],
  ]) {
    const result = invoke(directory, args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(ajv.getSchema("results#/definitions/ErrorEnvelope")!(JSON.parse(result.stderr))).toBe(true);
  }
  expect(success(directory, ["task", "view", "APP-1"]).title).toBe("Alpha");
  expect(success(directory, ["label", "list"])).toHaveLength(1);
});

test("info with unresolved storage still produces a valid successful report", () => {
  const directory = fixtureDirectory(true);
  const home = join(directory, "home");
  const cwd = join(directory, "repo");
  mkdirSync(home);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(cwd, "zinn.local.json"), "{");
  const result = runCli(["info", "--json"], {
    cwd, env: { ...process.env, HOME: home, ZINN_DIR: undefined, ZINN_DEBUG: undefined, DEBUG: undefined },
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.storage.directory).toBeNull();
  expect(report.database.state).toBe("unavailable");
  expect(ajv.getSchema("results#/definitions/Info")!(report)).toBe(true);
});

test("a declined text confirmation succeeds and preserves the task", async () => {
  const directory = fixtureDirectory();
  const result = await runCliInTerminal(["task", "delete", "APP-1"], {
    cwd: root, env: { ...process.env, ZINN_DIR: directory }, input: "n\n", inputWhen: "[y/N]",
  });
  expect(result.code).toBe(0);
  expect(success(directory, ["task", "view", "APP-1"]).key).toBe("APP-1");
});
