import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { runCli, runProcessAsync } from "../packages/cli/testing.ts";

const MAX_DESCRIPTION_CHARACTERS = 1024;
const MAX_SKILL_LINES = 500;
const EXAMPLE_TIMEOUT_MS = 120_000;
const DEVELOPMENT_SUFFIX = "-dev";

/** Validates the skill and its manually maintained CLI review version. */
export function readWorkflowSkill(packageDirectory: string) {
  const { skill, reviewedVersion } = readSkillFile(packageDirectory);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const cliVersion: string = manifest.version;
  // A development version is not a release yet. The review happens before the release commit removes -dev.
  const isDevelopmentVersion = cliVersion.endsWith(DEVELOPMENT_SUFFIX);
  if (!isDevelopmentVersion) {
    assert.equal(
      reviewedVersion,
      cliVersion,
      `Skill reviewed version ${reviewedVersion} must match CLI ${cliVersion}. Review the skill and update metadata.zinn-cli-reviewed-version.`,
    );
  }
  return skill;
}

/** Validates the skill's format and that it names a reviewed CLI version. */
function readSkillFile(packageDirectory: string): { skill: string; reviewedVersion: string } {
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

  const reviewedVersion = (metadata.metadata as Record<string, unknown> | undefined)?.[
    "zinn-cli-reviewed-version"
  ];
  assert.equal(
    typeof reviewedVersion,
    "string",
    "The skill needs metadata.zinn-cli-reviewed-version, the CLI release it was last reviewed against.",
  );
  return { skill, reviewedVersion: reviewedVersion as string };
}

/** Runs the skill's shell examples with the selected CLI and an isolated store. */
export async function checkSkillExamples(options: {
  packageDirectory: string;
  runtime: string;
  entryPoint: string;
  directory: string;
  env: Record<string, string | undefined>;
}) {
  const { packageDirectory, runtime, entryPoint, directory } = options;
  // Examples run against any version, including a packed copy that imitates a release.
  const { skill } = readSkillFile(packageDirectory);

  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "store"), { recursive: true });

  const env = {
    ...options.env,
    ZINN_DIR: join(directory, "store"),
    ZINN_SKILL_TEST_RUNTIME: runtime,
    ZINN_SKILL_TEST_CLI: entryPoint,
  };
  const cli = async (args: Array<string>) => {
    const result = await runCli(args, {
      runtime,
      cliPath: entryPoint,
      cwd: directory,
      env,
      timeoutMs: EXAMPLE_TIMEOUT_MS,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout;
  };

  await cli(["project", "create", "APP"]);
  await cli(["task", "create", "APP", "--title", "Verify the examples"]);

  const examples = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!);
  assert.ok(examples.length > 0, "The skill has no shell examples to check");

  const script =
    'set -e\nzinn() { "$ZINN_SKILL_TEST_RUNTIME" "$ZINN_SKILL_TEST_CLI" "$@"; }\n' +
    examples.join("\n");
  const result = await runProcessAsync(["/bin/sh", "-c", script], {
    cwd: directory,
    env,
    timeoutMs: EXAMPLE_TIMEOUT_MS,
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);

  const task = JSON.parse(await cli(["task", "view", "APP-1", "--json"]));
  assert.equal(task.column, "Review");
  assert.ok(task.comments.length > 0, "The examples did not record a handoff comment");
}
