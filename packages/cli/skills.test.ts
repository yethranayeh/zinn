import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { git } from "../../scripts/package-fixture.ts";
import { checkSkillExamples, readWorkflowSkill } from "../../scripts/skill-checks.ts";

const repositoryDirectory = join(import.meta.dir, "../..");
test("the bundled skill follows Agent Skills constraints and matches the CLI review version", () => {
  expect(() => readWorkflowSkill(import.meta.dir)).not.toThrow();
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
  try {
    expect(() => checkSkillExamples({
      packageDirectory: import.meta.dir,
      runtime: process.execPath,
      entryPoint: join(import.meta.dir, "index.ts"),
      directory,
      env: process.env,
    })).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
