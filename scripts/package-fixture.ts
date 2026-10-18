import { strict as assert } from "node:assert";
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACKAGE_NAMES = ["core", "cli"] as const;
export const GIT_CONTEXT_VARIABLES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
] as const;

// Ignore inherited Git paths so commands use only the requested repository.
export function git(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      ...Object.fromEntries(GIT_CONTEXT_VARIABLES.map((name) => [name, undefined])),
    },
  });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Creates a temporary source copy for package checks and links its build dependencies. */
export function createPackageTestCopy(repositoryDirectory: string, testCopyDirectory: string) {
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

  mkdirSync(testCopyDirectory, { recursive: true });
  for (const path of files) {
    const isDependencyPath = path.split("/").includes("node_modules");
    if (isDependencyPath) {
      continue;
    }
    const source = join(repositoryDirectory, path);
    if (!lstatSync(source, { throwIfNoEntry: false })) {
      continue;
    }
    const destination = join(testCopyDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { verbatimSymlinks: true });
  }

  // Register copied files so another package check can copy this directory too.
  git(testCopyDirectory, ["init", "--quiet", "--template="]);
  git(testCopyDirectory, ["add", "--all", "--force"]);

  symlinkSync(
    join(repositoryDirectory, "node_modules"),
    join(testCopyDirectory, "node_modules"),
    "junction",
  );

  symlinkSync(
    join(repositoryDirectory, "packages/core/node_modules"),
    join(testCopyDirectory, "packages/core/node_modules"),
    "junction",
  );

  const cliDependencies = join(testCopyDirectory, "packages/cli/node_modules/@zinn-dev");
  mkdirSync(cliDependencies, { recursive: true });
  symlinkSync(join(testCopyDirectory, "packages/core"), join(cliDependencies, "core"), "junction");

  const cliManifest = JSON.parse(
    readFileSync(join(repositoryDirectory, "packages/cli/package.json"), "utf8"),
  );

  const cliDependenciesToLink = { ...cliManifest.dependencies, ...cliManifest.devDependencies };
  for (const [name, version] of Object.entries(cliDependenciesToLink)) {
    if (String(version).startsWith("workspace:")) {
      continue;
    }

    const destination = join(testCopyDirectory, "packages/cli/node_modules", name);

    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(
      join(repositoryDirectory, "packages/cli/node_modules", name),
      destination,
      "junction",
    );
  }
}

/** Reads the minimum Node version declared by both packages. */
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
