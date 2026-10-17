import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "../../scripts/package-fixture.ts";
import { runCli } from "./testing.ts";

const repositoryDirectory = join(import.meta.dir, "../..");
const skillPath = join(import.meta.dir, "skills/zinn/SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const MAX_DESCRIPTION_CHARACTERS = 1024;
const MAX_SKILL_LINES = 500;

test("the bundled skill follows Agent Skills metadata and size constraints", () => {
  const frontmatter = Bun.YAML.parse(skill.match(/^---\n([\s\S]*?)\n---\n/)![1]!) as Record<string, unknown>;
  const specFields = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  expect(Object.keys(frontmatter).every((key) => specFields.has(key))).toBe(true);
  expect(frontmatter.name).toBe(basename(dirname(skillPath)));
  expect(typeof frontmatter.description).toBe("string");
  expect((frontmatter.description as string).trim().length).toBeGreaterThan(0);
  expect((frontmatter.description as string).length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARACTERS);
  expect(skill.split("\n").length).toBeLessThanOrEqual(MAX_SKILL_LINES);
});

test("the repository exposes only the bundled skill to installer discovery", () => {
  // Discovery can stop before its recursive fallback: https://github.com/vercel-labs/skills/blob/v1.7.2/src/skills.ts
  const skills = git(repositoryDirectory, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"])
    .split("\0")
    .filter((path) => basename(path) === "SKILL.md");
  expect(skills).toEqual(["packages/cli/skills/zinn/SKILL.md"]);
});

test("every shell example runs against an isolated project and completes its handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-skill-examples-"));
  const env = {
    ...process.env,
    ZINN_DIR: directory,
    ZINN_SKILL_TEST_RUNTIME: process.execPath,
    ZINN_SKILL_TEST_CLI: join(import.meta.dir, "index.ts"),
  };
  try {
    for (const args of [
      ["project", "create", "APP"],
      ["task", "create", "APP", "--title", "Verify the examples"],
    ]) {
      const result = runCli(args, { env, cwd: directory });
      expect(result.code, result.stderr).toBe(0);
    }
    const examples = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(examples.length).toBeGreaterThan(0);
    const script = 'set -e\nzinn() { "$ZINN_SKILL_TEST_RUNTIME" "$ZINN_SKILL_TEST_CLI" "$@"; }\n' + examples.join("\n");
    const result = Bun.spawnSync(["/bin/sh", "-c", script], { cwd: directory, env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const task = runCli(["task", "view", "APP-1", "--json"], { env, cwd: directory });
    expect(task.code, task.stderr).toBe(0);
    const data = JSON.parse(task.stdout);
    expect(data.column).toBe("Review");
    expect(data.comments.length).toBeGreaterThan(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
