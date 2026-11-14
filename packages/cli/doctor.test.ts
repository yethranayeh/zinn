import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "./testing.ts";
import type { PresentedDoctor } from "./src/result-schemas.ts";

// ZINN-134: zinn doctor.

/** The reviewed version of the skill that ships with the CLI, which `zinn skill install` installs. */
const bundledSkillVersion = /zinn-cli-reviewed-version:\s*"([^"]+)"/.exec(
  readFileSync(join(import.meta.dir, "skills", "zinn", "SKILL.md"), "utf8"),
)![1]!;

let root: string;
let home: string;
let cwd: string;
let store: string;
const runtime = process.env.ZINN_INFO_TEST_RUNTIME;
const cliPath = process.env.ZINN_INFO_TEST_CLI;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zinn-cli-doctor-")));
  home = join(root, "home");
  cwd = join(root, "repo");
  store = join(root, "store");
  mkdirSync(home);
  mkdirSync(cwd);
  mkdirSync(store);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: Array<string>, directory: string | undefined = store) {
  return runCli(args, {
    runtime,
    cliPath,
    cwd,
    env: { ...TEST_ENVIRONMENT, HOME: home, NODE_ENV: "test", ZINN_DIR: directory, AI_AGENT: "doctor-test", ZINN_DEBUG: undefined, DEBUG: undefined, DO_NOT_TRACK: undefined, FORCE_COLOR: "0" },
  });
}

async function report(expectedCode: number): Promise<PresentedDoctor> {
  const result = await run(["doctor", "--json"]);
  expect(result.code).toBe(expectedCode);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function find(found: PresentedDoctor, id: string) {
  return found.checks.find((check) => check.id === id);
}

function installSkill(version: string) {
  const path = join(home, ".agents", "skills", "zinn", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: zinn\ndescription: >-\n  A test skill.\nmetadata:\n  zinn-cli-reviewed-version: "${version}"\n---\n\nBody\n`);
}

async function seedStore() {
  for (const args of [["project", "create", "APP"], ["task", "create", "APP", "--title", "First"]]) {
    const result = await run(args);
    expect(result.code, result.stderr).toBe(0);
  }
}

test("a healthy store exits 0 with every check ok, in text and JSON, and creates nothing", async () => {
  // Bun's own cache may appear under HOME, so only the store and working folders are compared.
  const created = () => [readdirSync(store, { recursive: true }), readdirSync(cwd, { recursive: true }), existsSync(join(home, ".zinn"))];
  const before = created();
  const found = await report(0);
  expect(found.ok).toBe(true);
  expect(found.checks.map(({ id }) => id)).toEqual(["settings", "store_folder", "database", "agent_skill"]);
  expect(found.checks.every(({ status, remedy }) => status === "ok" && remedy === null)).toBe(true);

  const text = await run(["doctor"]);
  expect(text.code).toBe(0);
  expect(text.stderr).toBe("");
  expect(text.stdout).toContain("ok");
  expect(created()).toEqual(before);

  await seedStore();
  const seeded = await report(0);
  expect(seeded.checks.map(({ id }) => id)).toEqual(["settings", "store_folder", "database", "integrity", "foreign_keys", "search_index", "agent_skill"]);
});

test("a warning exits 1 and prints the checks on stdout with the remedy", async () => {
  await seedStore();
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(store, "data", "zinn.sqlite"));
  db.exec("DROP TABLE task_search");
  db.close();

  const found = await report(1);
  expect(found.ok).toBe(false);
  expect(find(found, "search_index")).toMatchObject({ status: "warning", remedy: expect.stringContaining("zinn reindex") });

  const text = await run(["doctor"]);
  expect(text.code).toBe(1);
  expect(text.stderr).toBe("");
  expect(text.stdout).toContain("warning");
  expect(text.stdout).toContain("zinn reindex");
});

test("a database file that is not SQLite is a problem, exits 1 and still prints the checks document", async () => {
  mkdirSync(join(store, "data"));
  writeFileSync(join(store, "data", "zinn.sqlite"), "not a database ".repeat(200));
  const found = await report(1);
  expect(found.ok).toBe(false);
  expect(find(found, "database")).toMatchObject({ status: "problem", remedy: expect.stringContaining("zinn restore") });
  expect(find(found, "integrity")).toBeUndefined();
});

test("an installed skill matching the bundled skill is ok", async () => {
  installSkill(bundledSkillVersion);
  const found = await report(0);
  expect(find(found, "agent_skill")).toMatchObject({ status: "ok", remedy: null });
});

test("an installed skill reviewed for another version than the bundled skill is a warning naming skill install", async () => {
  installSkill(`${bundledSkillVersion}-other`);
  const found = await report(1);
  expect(find(found, "agent_skill")).toMatchObject({ status: "warning", remedy: expect.stringContaining("zinn skill install") });

  writeFileSync(join(home, ".agents", "skills", "zinn", "SKILL.md"), "No frontmatter\n");
  const unreadable = await report(1);
  expect(find(unreadable, "agent_skill")).toMatchObject({ status: "warning", remedy: expect.stringContaining("zinn skill install") });
});

test("no installed skill is ok", async () => {
  const found = await report(0);
  expect(find(found, "agent_skill")).toMatchObject({ status: "ok", remedy: null });
  expect(existsSync(join(home, ".agents"))).toBe(false);
});

test("an extra argument takes the error path", async () => {
  const text = await run(["doctor", "extra-word"]);
  expect(text.code).toBe(1);
  expect(text.stdout).toBe("");
  expect(text.stderr).toContain("extra-word");

  const json = await run(["doctor", "extra-word", "--json"]);
  expect(json.code).toBe(1);
  expect(json.stdout).toBe("");
  expect(JSON.parse(json.stderr).error.code).toBeString();
});
