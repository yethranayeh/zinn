import { strict as assert } from "node:assert";
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACKAGE_NAMES = ["core", "cli"] as const;

function git(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
  });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Copies current tracked and nonignored files, then links the installed build dependencies. */
export function createPackageFixture(repositoryDirectory: string, fixtureDirectory: string) {
  const files = git(repositoryDirectory, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);

  mkdirSync(fixtureDirectory, { recursive: true });
  for (const path of files) {
    const isDependencyPath = path.split("/").includes("node_modules");
    if (isDependencyPath) {
      continue;
    }
    const source = join(repositoryDirectory, path);
    if (!lstatSync(source, { throwIfNoEntry: false })) {
      continue;
    }
    const destination = join(fixtureDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { verbatimSymlinks: true });
  }

  // Nested checks need the copied files' inventory, independent of the original repository.
  git(fixtureDirectory, ["init", "--quiet", "--template="]);
  git(fixtureDirectory, ["add", "--all", "--force"]);

  symlinkSync(
    join(repositoryDirectory, "node_modules"),
    join(fixtureDirectory, "node_modules"),
    "junction",
  );

  symlinkSync(
    join(repositoryDirectory, "packages/core/node_modules"),
    join(fixtureDirectory, "packages/core/node_modules"),
    "junction",
  );

  const cliDependencies = join(fixtureDirectory, "packages/cli/node_modules/@zinn-dev");
  mkdirSync(cliDependencies, { recursive: true });
  symlinkSync(join(fixtureDirectory, "packages/core"), join(cliDependencies, "core"), "junction");
}

/** Reads the common exact lower bound used by the packages' Node engine contracts. */
export function readNodeMinimum(repositoryDirectory: string) {
  const requirements = PACKAGE_NAMES.map((name) => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryDirectory, "packages", name, "package.json"), "utf8"),
    );
    return manifest.engines?.node;
  });

  const [coreRequirement, cliRequirement] = requirements;
  assert.equal(coreRequirement, cliRequirement, "Core and CLI engines.node requirements differ");
  assert.equal(typeof coreRequirement, "string", "Both packages must declare engines.node");

  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(coreRequirement);
  assert.ok(minimum, "engines.node must declare an exact lower bound: >=major.minor.patch");

  const version = minimum[1]!;
  return { version, major: Number(version.split(".")[0]) };
}
