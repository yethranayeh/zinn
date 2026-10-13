/** Prepares fresh release output, refusing prerelease packages and workspace dependencies. */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isPrerelease } from "../packages/core/src/release.ts";

const WORKSPACE_PREFIX = "workspace:";

type PackageJson = { name: string; version: string; dependencies?: Record<string, string> };

const packageDirectory = process.cwd();
const outputDirectory = join(packageDirectory, "dist");
const stagingDirectory = join(packageDirectory, "release-dist");

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  throw new Error(
    "Release preparation requires pnpm. Run pnpm pack or pnpm publish from the package directory.",
  );
}

function readPackageJson(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

/** The package.json of the sibling package with this name, from the folders next to this package. */
function findSiblingPackage(name: string) {
  const parentDirectory = dirname(packageDirectory);

  for (const entry of readdirSync(parentDirectory)) {
    const siblingDirectory = join(parentDirectory, entry);

    if (existsSync(join(siblingDirectory, "package.json"))) {
      const sibling = readPackageJson(siblingDirectory);

      if (sibling.name === name) {
        return sibling;
      }
    }
  }

  throw new Error(
    `No sibling package named ${name} for the workspace dependency of ${packageDirectory}`,
  );
}

/** The prerelease versions that would end up in the packed package, as "name version" lines. */
function findPrereleases() {
  const own = readPackageJson(packageDirectory);
  const prereleases = isPrerelease(own.version) ? [`${own.name} ${own.version}`] : [];

  for (const [name, range] of Object.entries(own.dependencies ?? {})) {
    if (range.startsWith(WORKSPACE_PREFIX)) {
      const sibling = findSiblingPackage(name);

      if (isPrerelease(sibling.version)) {
        prereleases.push(`${sibling.name} ${sibling.version}`);
      }
    }
  }

  return prereleases;
}

const prereleases = findPrereleases();

if (prereleases.length > 0) {
  throw new Error(
    `Refusing to pack a prerelease: ${prereleases.join(", ")}. Set the release version first.`,
  );
}

try {
  rmSync(stagingDirectory, { recursive: true, force: true });

  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: packageDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;

  if (exitCode !== 0) {
    throw new Error(`Release build failed with exit code ${exitCode}`);
  }

  cpSync(outputDirectory, stagingDirectory, {
    recursive: true,
    // Development dependency links must not enter release staging.
    filter: (source) => source !== join(outputDirectory, "node_modules"),
  });
  writeFileSync(
    join(stagingDirectory, "src", "release-identity.js"),
    'export const RELEASE_MODE = "published";\n',
  );
} catch (error) {
  rmSync(stagingDirectory, { recursive: true, force: true });
  throw error;
}
