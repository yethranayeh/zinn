import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDatabase } from "../packages/core/src/sqlite/bun.ts";
import { seedBaseline } from "../packages/core/src/migrations/testing.ts";
import { BASELINE_VERSION } from "../packages/core/src/migrations/baseline.ts";
import { latestVersion, MIGRATIONS } from "../packages/core/src/migrations/registry.ts";
import { createPackageTestCopy, PACKAGE_NAMES } from "./package-fixture.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const PACK_CHECK_TIMEOUT_MS = 60_000;

function run(command: string[], cwd: string, env = process.env) {
  const result = Bun.spawnSync(command, { cwd, env });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

test("pnpm packs fresh JS artifacts with independent identities and unchanged migration protection", () => {
  if (!Bun.which("pnpm")) {
    throw new Error("pnpm is required for packing checks. Install pnpm and rerun bun test.");
  }

  const root = mkdtempSync(join(tmpdir(), "zinn-pack-"));

  try {
    createPackageTestCopy(REPOSITORY_DIRECTORY, root);
    for (const name of PACKAGE_NAMES) {
      const directory = join(root, "packages", name);
      const manifestPath = join(directory, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.version = manifest.version.replace(/-dev$/, "");
      if (name === "core") {
        manifest.files.push("included.txt");
        appendFileSync(join(directory, "build.ts"), `
          const { writeFileSync } = await import("node:fs");
          writeFileSync(new URL("./dist/included.txt", import.meta.url), "selected by the package files list");
          writeFileSync(new URL("./dist/excluded.txt", import.meta.url), "not selected by the package files list");
        `);
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    const coreDirectory = join(root, "packages", "core");
    const cliDirectory = join(root, "packages", "cli");
    const sourceSnapshots = [coreDirectory, cliDirectory].map((directory) => ({
      directory,
      manifest: readFileSync(join(directory, "package.json"), "utf8"),
      identity: readFileSync(join(directory, "src/release-identity.ts"), "utf8"),
    }));
    const packDirectory = join(root, "tarballs");
    mkdirSync(packDirectory);
    const consumer = join(root, "consumer", "node_modules", "@zinn-dev");
    mkdirSync(consumer, { recursive: true });

    for (const name of PACKAGE_NAMES) {
      const directory = join(root, "packages", name);
      const sourceManifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const version = sourceManifest.version;
      const stagingDirectory = join(directory, sourceManifest.publishConfig.directory);
      // Packing must build, even when a previous output is incomplete.
      mkdirSync(stagingDirectory, { recursive: true });
      writeFileSync(join(stagingDirectory, "obsolete.js"), "throw new Error('stale release');");
      run(["pnpm", "pack", "--pack-destination", packDirectory], directory);
      const developmentIdentityUrl = pathToFileURL(join(directory, "dist", "src/release-identity.js")).href;
      expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(developmentIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
      const archive = join(packDirectory, `zinn-dev-${name}-${version}.tgz`);
      const members = run(["tar", "-tzf", archive], root).trim().split("\n");
      expect(members).toContain("package/index.js");
      expect(members).toContain("package/index.d.ts");
      expect(members).toContain("package/README.md");
      expect(members).toContain("package/LICENSE");
      expect(members).toContain("package/src/release-identity.js");
      expect(members.some((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))).toBe(false);
      expect(members.some((path) => /node_modules|obsolete|release-stamp|AGENTS|NOTES|build\.test/.test(path))).toBe(false);
      if (name === "core") {
        expect(members).toContain("package/included.txt");
        expect(members).not.toContain("package/excluded.txt");
      }
      const extracted = join(consumer, name);
      mkdirSync(extracted);
      run(["tar", "-xzf", archive, "-C", extracted, "--strip-components=1"], root);
      if (name === "core") {
        symlinkSync(join(REPOSITORY_DIRECTORY, "packages", "core", "node_modules"), join(extracted, "node_modules"), "junction");
      } else {
        const cliManifest = JSON.parse(readFileSync(join(REPOSITORY_DIRECTORY, "packages/cli/package.json"), "utf8"));
        for (const [dependency, version] of Object.entries(cliManifest.dependencies)) {
          if (!String(version).startsWith("workspace:")) {
            const dependencyPath = join(extracted, "node_modules", dependency);
            mkdirSync(join(dependencyPath, ".."), { recursive: true });
            symlinkSync(join(REPOSITORY_DIRECTORY, "packages/cli/node_modules", dependency), dependencyPath, "junction");
          }
        }
      }
      const manifest = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
      expect(manifest.exports).toEqual({ ".": { types: "./index.d.ts", import: "./index.js" } });
      expect(manifest.types).toBe("./index.d.ts");
      expect(manifest).not.toHaveProperty("zinnRelease");
      expect(manifest.scripts).toBeUndefined();
      if (name === "core") {
        expect(manifest.imports["#sqlite"]).toEqual({ bun: "./src/sqlite/bun.js", default: "./src/sqlite/node.js" });
      } else {
        expect(manifest.dependencies["@zinn-dev/core"]).toBe(JSON.parse(readFileSync(join(coreDirectory, "package.json"), "utf8")).version);
        expect(manifest.dependencies.zod).toBe(JSON.parse(readFileSync(join(coreDirectory, "package.json"), "utf8")).dependencies.zod);
        expect(manifest.bin.zinn).toBe("./index.js");
        expect(readFileSync(join(extracted, "index.js"), "utf8")).toStartWith("#!/usr/bin/env node");
      }
    }

    for (const { directory, manifest, identity } of sourceSnapshots) {
      expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(join(directory, "src/release-identity.ts"), "utf8")).toBe(identity);
    }
    const packedCore = join(consumer, "core");
    const packedCli = join(consumer, "cli");
    const coreStagingDirectory = join(coreDirectory, JSON.parse(sourceSnapshots[0]!.manifest).publishConfig.directory);
    const stagedCoreIdentityUrl = pathToFileURL(join(coreStagingDirectory, "src/release-identity.js")).href;
    // The CLI's core rebuild must leave the prepared core release intact.
    expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(stagedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("published");
    const identitiesCode = `Promise.all([
      import(${JSON.stringify(pathToFileURL(join(packedCore, "src/release.js")).href)}),
      import(${JSON.stringify(pathToFileURL(join(packedCli, "src/database.js")).href)})
    ]).then(([core, cli]) => console.log(JSON.stringify({ core: core.readCoreReleaseMode(), cli: cli.getCliOpenPolicy().release })));`;
    for (const runtime of ["bun", "node"]) {
      expect(JSON.parse(run([runtime, "--eval", identitiesCode], root))).toEqual({ core: "published", cli: "published" });
    }

    // Only disposable packed output receives the test migration.
    const registryPath = join(packedCore, "src/migrations/registry.js");
    const testMigrationVersion = latestVersion(MIGRATIONS) + 1;
    appendFileSync(registryPath, `\nMIGRATIONS.push({ version: ${testMigrationVersion}, name: "test upgrade", rebuilds: [], apply(db) { db.exec("CREATE TABLE pack_test (value TEXT)"); } });\n`);

    const cases = [
      { core: "source", cli: "source", isolated: false, upgrades: false },
      { core: "published", cli: "source", isolated: false, upgrades: false },
      { core: "source", cli: "published", isolated: false, upgrades: false },
      { core: "published", cli: "published", isolated: false, upgrades: true },
      { core: "source", cli: "source", isolated: true, upgrades: true },
    ] as const;
    for (const [index, state] of cases.entries()) {
      writeFileSync(join(packedCore, "src/release-identity.js"), `export const RELEASE_MODE = "${state.core}";\n`);
      writeFileSync(join(packedCli, "src/release-identity.js"), `export const RELEASE_MODE = "${state.cli}";\n`);
      const home = join(root, `home-${index}`);
      const store = join(home, state.isolated ? "isolated-store" : ".zinn");
      mkdirSync(join(store, "data"), { recursive: true });
      const databasePath = join(store, "data", "zinn.sqlite");
      const seed = openDatabase(databasePath);
      seedBaseline(seed);
      seed.close();
      const env = { ...process.env, HOME: home, ZINN_DIR: store };
      run(["bun", join(packedCli, "index.js"), "project", "list", "--json"], home, env);
      let database = openDatabase(databasePath);
      expect(database.query<{ user_version: number }>("PRAGMA user_version").get()!.user_version).toBe(state.upgrades ? testMigrationVersion : BASELINE_VERSION);
      expect(database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'pack_test'").get() !== null).toBe(state.upgrades);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      database.close();
      if (!state.upgrades) {
        const refused = Bun.spawnSync(["bun", join(packedCli, "index.js"), "project", "create", "REFUSED", "--json"], { cwd: home, env });
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout.toString()).toBe("");
        run(["bun", join(packedCli, "index.js"), "migrate", "--json"], home, env);
        database = openDatabase(databasePath);
        expect(database.query<{ user_version: number }>("PRAGMA user_version").get()!.user_version).toBe(testMigrationVersion);
        expect(database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'pack_test'").get()).not.toBeNull();
        database.close();
      }
    }

    run(["bun", "run", "build"], cliDirectory);
    expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(stagedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("published");
    for (const directory of [coreDirectory, cliDirectory]) {
      const identityUrl = pathToFileURL(join(directory, "dist", "src/release-identity.js")).href;
      expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(identityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
      expect(readFileSync(join(directory, "src/release-identity.ts"), "utf8")).toContain('"source"');
    }
    const coreLink = join(cliDirectory, "dist", "node_modules", "@zinn-dev", "core");
    const linkedCoreIdentityUrl = pathToFileURL(join(coreLink, "src/release-identity.js")).href;
    expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(linkedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PACK_CHECK_TIMEOUT_MS);
