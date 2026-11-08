/** Installs a published CLI release and builds its fixture databases. */

import { existsSync, statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Runner } from "../quiet-session/runner.ts";
import { assertInside, canonicalPath } from "./paths.ts";
import { measuredEnvironment, runWithEnvironment } from "./exec.ts";

const CLI_PACKAGE = "@zinn-dev/cli";
const CORE_PACKAGE = "@zinn-dev/core";
const GROW_SCRIPT = path.join(import.meta.dir, "grow.mjs");

type ResolvedPackage = {
  name: string;
  version: string;
};

type PnpmDependency = {
  version?: string;
  dependencies?: Record<string, PnpmDependency>;
  devDependencies?: Record<string, PnpmDependency>;
  optionalDependencies?: Record<string, PnpmDependency>;
};

export type InstallInfo = {
  installDirectory: string;
  cliIndex: string;
  cliVersion: string;
  coreVersion: string;
  coreIndex: string;
};

export type FixtureSpec = {
  name: string;
  tasks: number;
  comments: boolean;
};

export function fixtureSpec(tasks: number, comments: boolean): FixtureSpec {
  return { name: `t${tasks}-c${comments ? 1 : 0}`, tasks, comments };
}

export function fixtureDatabasePath(fixturesDirectory: string, name: string): string {
  return path.join(fixturesDirectory, name, "data", "zinn.sqlite");
}

/** Reuses the install for this version, or installs it exactly from npm. */
export async function ensureInstall(options: {
  version: string;
  workDirectory: string;
  runner: Runner;
}): Promise<InstallInfo> {
  const installDirectory = path.join(options.workDirectory, "install");
  const cliIndex = path.join(installDirectory, "node_modules", CLI_PACKAGE, "index.js");
  if (existsSync(cliIndex)) {
    console.log(`Reusing install in ${installDirectory}`);
  } else {
    await mkdir(installDirectory, { recursive: true });
    console.log(`Installing ${CLI_PACKAGE}@${options.version} in ${installDirectory}`);
    await writeFile(
      path.join(installDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "zinn-measure",
          private: true,
          dependencies: {
            [CLI_PACKAGE]: options.version,
          },
        },
        null,
        2,
      )}\n`,
    );
    const result = await options.runner.capture(["pnpm", "install", "--ignore-workspace"], {
      cwd: installDirectory,
    });
    if (result.exitCode !== 0) {
      throw new Error(`pnpm install failed:\n${result.stderr.trim()}`);
    }
  }

  const resolvedPackages = await listResolvedPackages(installDirectory, options.runner);
  const cliPackage = resolvedPackages.find((entry) => entry.name === CLI_PACKAGE);
  if (cliPackage === undefined) {
    throw new Error(`The install did not resolve ${CLI_PACKAGE}`);
  }
  const corePackage = resolvedPackages.find((entry) => entry.name === CORE_PACKAGE);
  if (corePackage === undefined) {
    throw new Error(`The install did not resolve ${CORE_PACKAGE}`);
  }
  const coreIndex = path.join(
    installDirectory,
    "node_modules",
    ".pnpm",
    `@zinn-dev+core@${corePackage.version}`,
    "node_modules",
    "@zinn-dev",
    "core",
    "index.js",
  );
  if (!existsSync(coreIndex)) {
    throw new Error(`The install has no core entry point at ${coreIndex}`);
  }
  return {
    installDirectory,
    cliIndex,
    cliVersion: cliPackage.version,
    coreVersion: corePackage.version,
    coreIndex,
  };
}

async function listResolvedPackages(
  installDirectory: string,
  runner: Runner,
): Promise<ResolvedPackage[]> {
  const result = await runner.capture(["pnpm", "list", "--depth", "Infinity", "--json"], {
    cwd: installDirectory,
  });
  if (result.exitCode !== 0) {
    throw new Error(`pnpm list failed:\n${result.stderr.trim()}`);
  }
  return collectResolvedPackages(JSON.parse(result.stdout) as PnpmDependency[]);
}

function collectResolvedPackages(entries: PnpmDependency[]): ResolvedPackage[] {
  const found = new Map<string, string>();

  function walk(dependencies: Record<string, PnpmDependency> | undefined): void {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (dependency.version === undefined) {
        continue;
      }
      const existing = found.get(name);
      if (existing !== undefined && existing !== dependency.version) {
        throw new Error(`${name} resolved at two versions: ${existing} and ${dependency.version}`);
      }
      found.set(name, dependency.version);
      walk(dependency.dependencies);
      walk(dependency.devDependencies);
      walk(dependency.optionalDependencies);
    }
  }

  for (const entry of entries) {
    walk(entry.dependencies);
    walk(entry.devDependencies);
    walk(entry.optionalDependencies);
  }

  return [...found.entries()]
    .map(([name, version]) => ({ name, version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Reuses an existing fixture, or builds a missing one with the copied grow.mjs. */
export async function ensureFixture(options: {
  spec: FixtureSpec;
  fixturesDirectory: string;
  workDirectory: string;
  coreIndex: string;
  nodePath: string;
}): Promise<number> {
  const databasePath = fixtureDatabasePath(options.fixturesDirectory, options.spec.name);
  if (existsSync(databasePath)) {
    const bytes = statSync(databasePath).size;
    console.log(`Reusing fixture ${options.spec.name}: ${bytes} bytes`);
    return bytes;
  }

  const fixtureDirectory = assertInside(
    path.join(options.fixturesDirectory, options.spec.name),
    options.workDirectory,
    "a fixture directory",
  );
  await mkdir(fixtureDirectory, { recursive: true });
  console.log(`Building fixture ${options.spec.name}`);
  const result = await runWithEnvironment(
    [
      options.nodePath,
      GROW_SCRIPT,
      fixtureDirectory,
      String(options.spec.tasks),
      options.spec.comments ? "1" : "0",
      options.coreIndex,
      canonicalPath(options.workDirectory),
    ],
    {
      cwd: options.workDirectory,
      environment: measuredEnvironment(fixtureDirectory),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Building fixture ${options.spec.name} failed:\n${result.stderr.trim()}`);
  }

  const walPath = `${databasePath}-wal`;
  if (existsSync(walPath)) {
    throw new Error(`Fixture ${options.spec.name} left ${walPath}`);
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Fixture ${options.spec.name} wrote no ${databasePath}`);
  }
  const bytes = (await stat(databasePath)).size;
  console.log(`Fixture ${options.spec.name}: ${bytes} bytes`);
  return bytes;
}
