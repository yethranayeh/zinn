import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflowSkill, checkSkillExamples } from "./skill-checks.ts";

const repositoryDirectory = join(import.meta.dir, "..");
const cliDirectory = join(repositoryDirectory, "packages/cli");
const manifest = JSON.parse(readFileSync(join(cliDirectory, "package.json"), "utf8"));
const releaseVersion = manifest.version.replace(/-dev$/, "");
const skill = readFileSync(join(cliDirectory, "skills/zinn/SKILL.md"), "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)!;
const fields = Bun.YAML.parse(frontmatter[1]!) as Record<string, unknown>;

function writeSkillFixture(directory: string, version: string, reviewedVersion: string | undefined) {
  const packageDirectory = join(directory, "packages/cli");
  mkdirSync(join(packageDirectory, "skills/zinn"), { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ ...manifest, version }));
  const metadata = { ...fields, metadata: { "zinn-cli-reviewed-version": reviewedVersion } };
  const source = `---\n${JSON.stringify(metadata)}\n---\n${skill.slice(frontmatter[0].length)}`;
  writeFileSync(join(packageDirectory, "skills/zinn/SKILL.md"), source);
  return packageDirectory;
}

test.each(["", "-dev", "-dev.1"])("the review version ignores only the exact development suffix: %s", (suffix) => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-skill-version-"));
  try {
    const packageDirectory = writeSkillFixture(directory, releaseVersion + suffix, releaseVersion);
    if (suffix === "-dev.1") {
      expect(() => readWorkflowSkill(packageDirectory)).toThrow();
    } else {
      expect(() => readWorkflowSkill(packageDirectory)).not.toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["0.0.0", "999.0.0", undefined])("pnpm publish blocks an unmatched skill review version before packing: %s", (reviewedVersion) => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-skill-publish-"));
  try {
    const packageDirectory = writeSkillFixture(directory, releaseVersion, reviewedVersion);
    mkdirSync(join(directory, "scripts"));
    for (const file of ["verify-installed.ts", "skill-checks.ts", "package-fixture.ts", "archive-cache.ts"]) {
      copyFileSync(join(import.meta.dir, file), join(directory, "scripts", file));
    }
    copyFileSync(join(cliDirectory, "testing.ts"), join(packageDirectory, "testing.ts"));
    const packagePath = join(packageDirectory, "package.json");
    const fixtureManifest = JSON.parse(readFileSync(packagePath, "utf8"));
    fixtureManifest.scripts.prepack = "bun ../../prepack.ts";
    writeFileSync(packagePath, JSON.stringify(fixtureManifest));
    writeFileSync(join(directory, "prepack.ts"), 'await Bun.write("prepack-ran", "unexpected");\n');

    const result = Bun.spawnSync(["pnpm", "publish", "--dry-run", "--no-git-checks"], {
      cwd: packageDirectory,
      env: process.env,
      timeout: 30_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).not.toBe(0);
    expect(output).toContain("zinn-cli-reviewed-version");
    expect(output).toContain(releaseVersion);
    if (reviewedVersion !== undefined) {
      expect(output).toContain(reviewedVersion);
    }
    expect(existsSync(join(packageDirectory, "prepack-ran"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed skill example stops verification in an isolated store", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-skill-failure-"));
  try {
    const packageDirectory = writeSkillFixture(directory, releaseVersion, releaseVersion);
    const skillPath = join(packageDirectory, "skills/zinn/SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf8").replace(/```sh\n[\s\S]*?```/, "```sh\nzinn unknown-command\n```"));
    const inheritedStore = join(directory, "inherited-store");
    expect(() => checkSkillExamples({
      packageDirectory,
      runtime: process.execPath,
      entryPoint: join(cliDirectory, "index.ts"),
      directory: join(directory, "examples"),
      env: { ...process.env, ZINN_DIR: inheritedStore },
    })).toThrow();
    expect(existsSync(inheritedStore)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
