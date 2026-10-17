import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { runCli } from "../packages/cli/testing.ts";

const MAX_DESCRIPTION_CHARACTERS = 1024;
const MAX_SKILL_LINES = 500;
const EXAMPLE_TIMEOUT_MS = 120_000;

/** Validates the skill and its manually maintained CLI review version. */
export function readWorkflowSkill(packageDirectory: string) {
  const skillPath = join(packageDirectory, "skills/zinn/SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "The workflow skill needs YAML frontmatter");

  const metadata = Bun.YAML.parse(frontmatter[1]!) as Record<string, unknown>;
  const specFields = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);

  assert.ok(
    Object.keys(metadata).every((key) => specFields.has(key)),
    "Unknown skill frontmatter field",
  );
  assert.equal(metadata.name, basename(dirname(skillPath)));
  assert.equal(typeof metadata.description, "string");

  const description = metadata.description as string;
  assert.ok(description.trim().length > 0, "The skill description must not be empty");
  assert.ok(description.length <= MAX_DESCRIPTION_CHARACTERS, "The skill description is too long");
  assert.ok(skill.split("\n").length <= MAX_SKILL_LINES, "The skill is too long");

  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const releaseVersion = manifest.version.replace(/-dev$/, "");
  const reviewedVersion = (metadata.metadata as Record<string, unknown> | undefined)?.[
    "zinn-cli-reviewed-version"
  ];
  assert.equal(
    reviewedVersion,
    releaseVersion,
    `Skill reviewed version ${reviewedVersion ?? "missing"} must match CLI ${releaseVersion}. Review the skill and update metadata.zinn-cli-reviewed-version.`,
  );

  return skill;
}

/** Runs the skill's shell examples with the selected CLI and an isolated store. */
export function checkSkillExamples(options: {
  packageDirectory: string;
  runtime: string;
  entryPoint: string;
  directory: string;
  env: Record<string, string | undefined>;
}) {
  const { packageDirectory, runtime, entryPoint, directory } = options;
  const skill = readWorkflowSkill(packageDirectory);

  mkdirSync(directory, { recursive: true });

  const env = {
    ...options.env,
    ZINN_DIR: join(directory, "store"),
    ZINN_SKILL_TEST_RUNTIME: runtime,
    ZINN_SKILL_TEST_CLI: entryPoint,
  };
  const cli = (args: string[]) => {
    const result = runCli(args, {
      runtime,
      cliPath: entryPoint,
      cwd: directory,
      env,
      timeoutMs: EXAMPLE_TIMEOUT_MS,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout;
  };

  cli(["project", "create", "APP"]);
  cli(["task", "create", "APP", "--title", "Verify the examples"]);

  const examples = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!);
  assert.ok(examples.length > 0, "The skill has no shell examples to check");

  const script =
    'set -e\nzinn() { "$ZINN_SKILL_TEST_RUNTIME" "$ZINN_SKILL_TEST_CLI" "$@"; }\n' +
    examples.join("\n");
  const result = Bun.spawnSync(["/bin/sh", "-c", script], {
    cwd: directory,
    env,
    timeout: EXAMPLE_TIMEOUT_MS,
  });

  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());

  const task = JSON.parse(cli(["task", "view", "APP-1", "--json"]));
  assert.equal(task.column, "Review");
  assert.ok(task.comments.length > 0, "The examples did not record a handoff comment");
}
