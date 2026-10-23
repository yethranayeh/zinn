import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
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
import type { Column, CommentWithKey, Label, Project, TaskRelation, TaskWithKey } from "../core/src/types";
import { relationTypeSchema } from "@zinn-dev/core";

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
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, AI_AGENT: "contract-test", FORCE_COLOR: "0", ZINN_DEBUG: undefined, DEBUG: undefined },
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

function readEntityRows(directory: string) {
  const db = new Database(join(directory, "data", "zinn.sqlite"), { readonly: true });
  try {
    return {
      projects: db.query<Project, []>("SELECT * FROM project").all(),
      columns: db.query<Column, []>("SELECT * FROM project_column").all(),
      tasks: db.query<TaskWithKey, []>(`
        SELECT task.*, project.key || '-' || task.number AS key
        FROM task JOIN project ON project.id = task.project_id
      `).all(),
      comments: db.query<CommentWithKey, []>(`
        SELECT comment.*, project.key || '-' || task.number || '#' || comment.number AS key
        FROM comment JOIN task ON task.id = comment.task_id
        JOIN project ON project.id = task.project_id
      `).all(),
      labels: db.query<Label, []>("SELECT * FROM label").all(),
      relations: db.query<TaskRelation, []>("SELECT * FROM task_relations").all(),
      attachments: db.query<{ task_id: string; label_id: string }, []>("SELECT * FROM task_label").all(),
    };
  } finally {
    db.close();
  }
}

function expectEntityIds(schema: ResultSchemaName, value: any, rows: ReturnType<typeof readEntityRows>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectEntityIds(schema, item, rows);
    }
    return;
  }

  expect(Object.keys(value)[0]).toBe("id");
  switch (schema) {
    case "Task":
    case "TaskList":
    case "TaskDetail":
    case "TaskDetailHistory":
    case "TaskChange":
    case "TaskChanges": {
      const stored = rows.tasks.find((task) => task.key === value.key)!;
      expect(stored).toBeDefined();
      expect(value).toMatchObject({ id: stored.id, project_id: stored.project_id, column_id: stored.column_id });
      expect(rows.columns.find((column) => column.id === value.column_id)?.name).toBe(value.column);
      expect(value.label_ids).toEqual(value.labels.map((name: string) => rows.labels.find((label) => label.name === name)!.id));
      expect([...value.label_ids].sort()).toEqual(rows.attachments.filter((entry) => entry.task_id === stored.id).map((entry) => entry.label_id).sort());
      for (const relation of value.relations ?? []) {
        expectEntityIds("Relation", relation, rows);
      }
      for (const comment of value.comments ?? []) {
        expectEntityIds("Comment", comment, rows);
      }
      break;
    }
    case "Project":
    case "ProjectList":
    case "ProjectView": {
      expect(value.id).toBe(rows.projects.find((project) => project.key === value.key)!.id);
      for (const column of value.columns ?? []) {
        expectEntityIds("ColumnTaskCount", column, rows);
        expect(rows.columns.find((entry) => entry.id === column.id)!.project_id).toBe(value.id);
      }
      break;
    }
    case "Column":
    case "ColumnList":
    case "ColumnTaskCount": {
      const stored = rows.columns.find((column) => column.id === value.id)!;
      expect(stored).toBeDefined();
      expect(value.name).toBe(stored.name);
      if (schema === "Column") {
        expect(value.project_id).toBe(stored.project_id);
        expect(value.project).toBe(rows.projects.find((project) => project.id === stored.project_id)!.key);
      }
      break;
    }
    case "Label":
    case "LabelList": {
      expect(value.id).toBe(rows.labels.find((label) => label.name === value.name)!.id);
      break;
    }
    case "Comment":
    case "CommentList": {
      const stored = rows.comments.find((comment) => comment.key === value.key)!;
      expect(value).toMatchObject({ id: stored.id, task_id: stored.task_id });
      break;
    }
    case "Relation":
    case "RelationList": {
      const stored = rows.relations.find((relation) => relation.id === value.id)!;
      expect(stored).toBeDefined();
      expect(value.type).toBe(stored.relation_type);
      expect([stored.source_task_id, stored.target_task_id]).toContain(value.task.id);
      expect(Object.keys(value.task)[0]).toBe("id");
      const task = rows.tasks.find((task) => task.key === value.task.key)!;
      expect(value.task).toMatchObject({ id: task.id, project_id: task.project_id, column_id: task.column_id });
      break;
    }
    case "RelationChange": {
      const stored = rows.relations.find((relation) => relation.id === value.id)!;
      expect(stored).toBeDefined();
      expect(value.type).toBe(stored.relation_type);
      expect(value.source_task_id).toBe(rows.tasks.find((task) => task.key === value.source)!.id);
      expect(value.target_task_id).toBe(rows.tasks.find((task) => task.key === value.target)!.id);
      expect([value.source_task_id, value.target_task_id].sort()).toEqual([stored.source_task_id, stored.target_task_id].sort());
      break;
    }
    default: {
      throw new Error(`No entity identity check for ${schema}`);
    }
  }
}

beforeAll(() => {
  mkdirSync(seed);
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
  "task edit": [
    { schema: "TaskChange", args: ["APP-1", "--title", "Edited"], check: (v) => expect(v.changed).toBe(true) },
    { schema: "TaskChange", args: ["APP-1", "--title", "Alpha"], check: (v) => expect(v.changed).toBe(false) },
  ],
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
  "task label add": [
    { schema: "TaskChange", args: ["APP-2", "bug"], check: (v) => expect(v.changed).toBe(true) },
    { schema: "TaskChange", args: ["APP-1", "bug"], check: (v) => expect(v.changed).toBe(false) },
  ],
  "task label remove": [
    { schema: "TaskChange", args: ["APP-1", "bug"], check: (v) => expect(v.changed).toBe(true) },
    { schema: "TaskChange", args: ["APP-2", "bug"], check: (v) => expect(v.changed).toBe(false) },
  ],
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
  "label view": [{ schema: "Label", args: ["bug"] }],
  "label edit": [{ schema: "Label", args: ["bug", "--color", "green"] }],
  "label delete": [{ schema: "Label", args: ["bug", "--yes"] }],
  "activity list": [{ schema: "ActivityList", args: [] }, { schema: "ActivityList", args: ["--task", "APP-999", "--show-deleted"] }],
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
      const hasEntities = ["project", "task", "label"].includes(route.command.split(" ")[0]!);
      const deletedRows = hasEntities && route.effects.domain === "delete" ? readEntityRows(directory) : undefined;
      const result = invoke(directory, [...route.command.split(" "), ...args]);
      expect(result.code, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      const ref = descriptor.schemaRef.replace("#/schemas/", "results#/");
      const validate = ajv.getSchema(ref)!;
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      fixture.check?.(value);
      if (hasEntities) {
        expectEntityIds(fixture.schema, value, deletedRows ?? readEntityRows(directory));
      }
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

test("entity identities survive renames and distinguish recreated handles", () => {
  const directory = fixtureDirectory(true);
  const project = success(directory, ["project", "create", "APP"]);
  const alpha = success(directory, ["label", "create", "alpha"]);
  const zeta = success(directory, ["label", "create", "zeta"]);
  const task = success(directory, ["task", "create", "APP", "--title", "Identity", "--label", "zeta", "--label", "alpha"]);
  const column = success(directory, ["project", "column", "list", "APP"])[0];
  expect(task).toMatchObject({ project_id: project.id, column_id: column.id });
  expect(task.label_ids).toEqual(task.labels.map((name: string) => ({ alpha, zeta })[name as "alpha" | "zeta"].id));

  expect(success(directory, ["project", "edit", "APP", "--name", "Renamed project"]).id).toBe(project.id);
  expect(success(directory, ["project", "column", "edit", "APP", column.name, "--name", "Ideas"]).id).toBe(column.id);
  expect(success(directory, ["label", "edit", "zeta", "--name", "renamed"]).id).toBe(zeta.id);
  const viewed = success(directory, ["task", "view", task.key]);
  expect(viewed).toMatchObject({ id: task.id, project_id: project.id, column_id: column.id, column: "Ideas" });
  expect(viewed.labels).toContain("renamed");
  const labelsByName = new Map([["alpha", alpha.id], ["renamed", zeta.id]]);
  expect(viewed.label_ids).toEqual(viewed.labels.map((name: string) => labelsByName.get(name)));
  expectEntityIds("TaskDetail", viewed, readEntityRows(directory));

  const comment = success(directory, ["task", "comment", "create", task.key, "--text", "Identity comment"]);
  for (const args of [
    ["task", "comment", "view", comment.key],
    ["task", "comment", "edit", comment.key, "--text", "Edited comment"],
    ["task", "comment", "delete", comment.key, "--yes"],
  ]) {
    expect(success(directory, args)).toMatchObject({ id: comment.id, task_id: task.id });
  }
  const activity = success(directory, ["activity", "list", "--task-id", task.id]);
  expect(activity.length).toBeGreaterThan(0);
  expect(activity.every((event: any) => event.entity_id === task.id)).toBe(true);

  expect(success(directory, ["label", "delete", "renamed", "--yes"]).id).toBe(zeta.id);
  expect(success(directory, ["label", "create", "renamed"]).id).not.toBe(zeta.id);
  expect(success(directory, ["project", "delete", "APP", "--yes"]).id).toBe(project.id);
  const recreatedProject = success(directory, ["project", "create", "APP"]);
  expect(recreatedProject.id).not.toBe(project.id);
  const recreatedTask = success(directory, ["task", "create", "APP", "--title", "New identity"]);
  expect(recreatedTask.key).toBe(task.key);
  expect(recreatedTask.id).not.toBe(task.id);
  expect(recreatedTask.column_id).not.toBe(column.id);
  expect(recreatedTask.project_id).toBe(recreatedProject.id);
});

test.each(relationTypeSchema.options)("%s relation identity is consistent from both ends and through deletion", (type) => {
  const directory = fixtureDirectory();
  success(directory, ["project", "create", "OTHER"]);
  const other = success(directory, ["task", "create", "OTHER", "--title", "Other project"]);
  const app = success(directory, ["task", "view", "APP-2"]);
  success(directory, ["task", "archive", other.key]);
  const [source, target] = type === "related" ? [other, app] : [app, other];
  const created = success(directory, ["task", "relation", "create", source.key, target.key, "--type", type]);
  expect(created).toMatchObject({ source: source.key, source_task_id: source.id, target: target.key, target_task_id: target.id });
  expectEntityIds("RelationChange", created, readEntityRows(directory));
  if (type === "related") {
    const stored = readEntityRows(directory).relations.find((relation) => relation.id === created.id)!;
    expect(stored.source_task_id).toBe(target.id);
    expect(stored.target_task_id).toBe(source.id);
  }

  for (const [viewed, connected] of [[app, other], [other, app]]) {
    const listed = success(directory, ["task", "relation", "list", viewed.key]).find((relation: any) => relation.id === created.id);
    expect(listed).toMatchObject({ id: created.id, type, task: { id: connected.id, key: connected.key, project_id: connected.project_id, column_id: connected.column_id } });
    expect(success(directory, ["task", "view", viewed.key]).relations).toContainEqual(listed);
    expectEntityIds("Relation", listed, readEntityRows(directory));
  }

  const [deleteSource, deleteTarget] = type === "related" ? [target, source] : [source, target];
  const deleted = success(directory, ["task", "relation", "delete", deleteSource.key, deleteTarget.key, "--type", type]);
  expect(deleted).toMatchObject({ id: created.id, source: deleteSource.key, source_task_id: deleteSource.id, target: deleteTarget.key, target_task_id: deleteTarget.id });
  expect(readEntityRows(directory).relations.some((relation) => relation.id === created.id)).toBe(false);
});

for (const route of commands) {
  for (const alias of route.aliases) {
    test(`${alias.join(" ")}: canonical results, errors and confirmations`, () => {
      const fixture = fixtures[route.command]![0]!;
      const directory = fixtureDirectory(fixture.empty);
      fixture.prepare?.(directory);
      const replacements: Record<string, string> = { $comment: commentKey, $event: eventId, $backup: backupPath };
      const args = fixture.args.map((arg) => replacements[arg] ?? arg);
      const canonicalPath = route.command.split(" ");
      const invalid = invoke(directory, [...canonicalPath, "--unknown"]);
      expect(invalid.code).toBe(1);
      expect(invoke(directory, [...alias, "--unknown"])).toEqual(invalid);

      if (route.confirmation.kind !== "none") {
        const withoutYes = args.filter((arg) => arg !== "--yes");
        for (const flags of [[], ["--json"]]) {
          const options = { cwd: root, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, FORCE_COLOR: "0" } };
          const canonicalRefusal = runCli([...canonicalPath, ...withoutYes, ...flags], options);
          expect(canonicalRefusal.code).toBe(1);
          expect(runCli([...alias, ...withoutYes, ...flags], options)).toEqual(canonicalRefusal);
        }
      }

      if (route.effects.domain === "read") {
        const options = { cwd: root, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory, FORCE_COLOR: "0" } };
        const canonicalText = runCli([...canonicalPath, ...args], options);
        expect(canonicalText.code, canonicalText.stderr).toBe(0);
        expect(runCli([...alias, ...args], options)).toEqual(canonicalText);
        expect(invoke(directory, [...alias, ...args])).toEqual(invoke(directory, [...canonicalPath, ...args]));
      }

      const value = success(directory, [...alias, ...args]);
      const descriptor = selectResult(route, args);
      const validate = ajv.getSchema(descriptor.schemaRef.replace("#/schemas/", "results#/"))!;
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      fixture.check?.(value);
    });
  }
}

test("alias words stay literal in project keys and task titles", () => {
  const directory = fixtureDirectory(true);
  success(directory, ["project", "new", "rm"]);
  const created = success(directory, ["task", "new", "rm", "--title", "show"]);
  expect(created.title).toBe("show");
  const listed = invoke(directory, ["task", "list", "rm"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).map((task: { key: string }) => task.key)).toEqual([created.key]);
  expect(invoke(directory, ["task", "ls", "rm"])).toEqual(listed);
});

test("unselected synonyms and aliases without a matching command stay unknown", () => {
  const directory = fixtureDirectory(true);
  for (const args of [
    ["show", "APP-1"], ["task", "read", "APP-1"], ["task", "mv", "APP-1", "Done"],
    ["task", "add", "APP"], ["task", "remove", "APP-1"], ["task", "label", "rm", "APP-1", "bug"],
  ]) {
    const result = invoke(directory, args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "invalid_input", details: { argument: "command" } });
  }
});

test("unknown stored vocabularies satisfy generated output schemas", () => {
  const directory = fixtureDirectory();
  editFixture(directory, `
    UPDATE task SET priority = 'future-priority';
    UPDATE label SET color = 'future-color';
    UPDATE task_relations SET relation_type = 'future-relation';
    UPDATE activity SET actor_kind = 'future-actor', entity_type = 'future-entity', action = 'future-action';
  `);
  const cases = [
    { args: ["task", "list", "APP"], schema: "TaskList", fields: { priority: "future-priority" } },
    { args: ["task", "move", "APP-1", "Done"], schema: "TaskChange", fields: { priority: "future-priority" } },
    { args: ["label", "list"], schema: "LabelList", fields: { color: "future-color" } },
    { args: ["task", "relation", "list", "APP-1"], schema: "RelationList", fields: { type: "future-relation" } },
    { args: ["activity", "view", eventId], schema: "Activity", fields: {
      actor_kind: "future-actor", entity_type: "future-entity", action: "future-action",
    } },
  ];
  for (const { args, schema, fields } of cases) {
    const value = success(directory, args);
    const validate = ajv.getSchema(`results#/definitions/${schema}`)!;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(Array.isArray(value) ? value[0] : value).toMatchObject(fields);
  }
});

test("newer database activity columns stay out of list, view and task history", () => {
  const directory = fixtureDirectory();
  editFixture(directory, `
    ALTER TABLE activity ADD COLUMN future_column TEXT DEFAULT 'future';
    PRAGMA user_version = 999;
  `);
  const cases = [
    { args: ["activity", "list"], schema: "ActivityList" },
    { args: ["activity", "view", eventId], schema: "Activity" },
    { args: ["task", "view", "APP-1", "--history"], schema: "TaskDetailHistory" },
  ];
  for (const { args, schema } of cases) {
    const value = success(directory, args);
    const validate = ajv.getSchema(`results#/definitions/${schema}`)!;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const events = Array.isArray(value) ? value : value.activity ?? [value];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(Object.hasOwn(event, "future_column")).toBe(false);
    }
  }
});

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
    cwd, env: { ...TEST_ENVIRONMENT, HOME: home, ZINN_DIR: undefined, ZINN_DEBUG: undefined, DEBUG: undefined },
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
    cwd: root, env: { ...TEST_ENVIRONMENT, ZINN_DIR: directory }, input: "n\n", inputWhen: "[y/N]",
  });
  expect(result.code).toBe(0);
  expect(success(directory, ["task", "view", "APP-1"]).key).toBe("APP-1");
});
