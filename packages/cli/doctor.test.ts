import { TEST_ENVIRONMENT } from "../../scripts/test-isolation.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(args: Array<string>, directory: string | undefined = store, workingFolder = cwd) {
  return runCli(args, {
    runtime,
    cliPath,
    cwd: workingFolder,
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

function installSkill(version: string, base = join(home, ".agents", "skills")) {
  const path = join(base, "zinn", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: zinn\ndescription: >-\n  A test skill.\nmetadata:\n  zinn-cli-reviewed-version: "${version}"\n---\n\nBody\n`);
}

/** Links `<base>/zinn` to another skill folder, as the skills CLI does for .claude/skills */
function linkSkill(base: string, target: string) {
  mkdirSync(base, { recursive: true });
  symlinkSync(target, join(base, "zinn"), "dir");
}

function skillPath(base: string) {
  return join(base, "zinn", "SKILL.md");
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

test("ZINN-622: a stale project copy is a warning naming its path and the project install", async () => {
  const projectBase = join(cwd, ".agents", "skills");
  installSkill(bundledSkillVersion);
  installSkill(`${bundledSkillVersion}-old`, projectBase);
  const found = await report(1);
  const check = find(found, "agent_skill")!;
  expect(check.status).toBe("warning");
  expect(check.message).toContain(skillPath(projectBase));
  expect(check.message).not.toContain(skillPath(join(home, ".agents", "skills")));
  expect(check.remedy).toContain("zinn skill install --project");
  expect(check.remedy).toContain(cwd);

  const text = await run(["doctor"]);
  expect(text.code).toBe(1);
  expect(text.stdout).toContain(skillPath(projectBase));
  expect(text.stdout).toContain("zinn skill install --project");
});

test("ZINN-622: matching home and project copies are ok", async () => {
  installSkill(bundledSkillVersion);
  installSkill(bundledSkillVersion, join(cwd, ".agents", "skills"));
  installSkill(bundledSkillVersion, join(cwd, ".claude", "skills"));
  const found = await report(0);
  expect(find(found, "agent_skill")).toMatchObject({ status: "ok", remedy: null });
});

test("ZINN-622: a .claude/skills link into .agents/skills is one copy", async () => {
  const projectBase = join(cwd, ".agents", "skills");
  installSkill(`${bundledSkillVersion}-old`, projectBase);
  linkSkill(join(cwd, ".claude", "skills"), join(projectBase, "zinn"));
  const found = await report(1);
  const check = find(found, "agent_skill")!;
  expect(check.status).toBe("warning");
  expect(check.message).toContain(skillPath(projectBase));
  expect(check.message).not.toContain(skillPath(join(cwd, ".claude", "skills")));
});

test("ZINN-622: a copy only in ~/.claude/skills is compared", async () => {
  const claudeBase = join(home, ".claude", "skills");
  installSkill(`${bundledSkillVersion}-old`, claudeBase);
  const stale = await report(1);
  const check = find(stale, "agent_skill")!;
  expect(check.status).toBe("warning");
  expect(check.message).toContain(skillPath(claudeBase));
  expect(check.remedy).toContain("zinn skill install");
  expect(check.remedy).not.toContain("--project");

  installSkill(bundledSkillVersion, claudeBase);
  expect(find(await report(0), "agent_skill")).toMatchObject({ status: "ok", remedy: null });
});

test("ZINN-622: a link that resolves to nothing is no copy", async () => {
  linkSkill(join(cwd, ".claude", "skills"), join(root, "missing"));
  const found = await report(0);
  expect(find(found, "agent_skill")).toMatchObject({ status: "ok", remedy: null });
});

test("ZINN-622: a working folder equal to HOME reports each file once", async () => {
  installSkill(`${bundledSkillVersion}-old`);
  const result = await run(["doctor", "--json"], store, home);
  expect(result.code).toBe(1);
  const check = find(JSON.parse(result.stdout), "agent_skill")!;
  const path = skillPath(join(home, ".agents", "skills"));
  expect(check.status).toBe("warning");
  expect(check.message.split(path).length - 1).toBe(1);
  expect(check.remedy).not.toContain("--project");
});

test("ZINN-622: stale home and project copies are named in one warning with both remedies", async () => {
  installSkill(`${bundledSkillVersion}-old`);
  installSkill(`${bundledSkillVersion}-old`, join(cwd, ".agents", "skills"));
  const found = await report(1);
  const checks = found.checks.filter(({ id }) => id === "agent_skill");
  expect(checks).toHaveLength(1);
  expect(checks[0]!.message).toContain(skillPath(join(home, ".agents", "skills")));
  expect(checks[0]!.message).toContain(skillPath(join(cwd, ".agents", "skills")));
  expect(checks[0]!.remedy).toContain("zinn skill install --project");
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
