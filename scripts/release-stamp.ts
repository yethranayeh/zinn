/**
 * Writes or removes the release stamp of the package in the current folder:
 *   `bun ../../scripts/release-stamp.ts write`    from the package's prepack script
 *   `bun ../../scripts/release-stamp.ts remove`   from its postpack script
 * Packing runs both, so only the packed package keeps the stamp.
 * `write` refuses to pack a prerelease (such as `0.39.0-dev`), or a package whose `workspace:`
 * dependency is one: pnpm packs `workspace:*` as that sibling's current version, which is not on npm.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PUBLISHED_STAMP, RELEASE_STAMP_FILE } from "../packages/core/src/release.ts";

const WORKSPACE_PREFIX = "workspace:";

type PackageJson = { name: string; version: string; dependencies?: Record<string, string> };

const packageDirectory = process.cwd();
const stampPath = join(packageDirectory, RELEASE_STAMP_FILE);
const action = process.argv[2];

function readPackageJson(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function isPrerelease(version: string) {
  return version.includes("-");
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

if (action === "write") {
  const prereleases = findPrereleases();

  if (prereleases.length > 0) {
    throw new Error(
      `Refusing to pack a prerelease: ${prereleases.join(", ")}. Set the release version first.`,
    );
  }

  writeFileSync(stampPath, `${JSON.stringify(PUBLISHED_STAMP)}\n`);
} else if (action === "remove") {
  rmSync(stampPath, { force: true });
} else {
  throw new Error("Usage: bun scripts/release-stamp.ts {write|remove}");
}
