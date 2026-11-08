import { TEST_ENVIRONMENT } from "./test-isolation.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDatabase } from "../packages/core/src/sqlite/bun.ts";
import { seedBaseline } from "../packages/core/src/migrations/testing.ts";
import { BASELINE_VERSION } from "../packages/core/src/migrations/baseline.ts";
import { latestVersion, MIGRATIONS } from "../packages/core/src/migrations/registry.ts";
import { createPackageTestCopy, PACKAGE_NAMES } from "./package-fixture.ts";
import { checkSkillExamples } from "./skill-checks.ts";
import { checkCapabilityDiscovery, checkCapabilityConsumer } from "../packages/cli/capability-checks.ts";
import { runCli } from "../packages/cli/testing.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
// The fixture runs both release builds and prepares the packed consumer layout.
const PACK_FIXTURE_TIMEOUT_MS = 120_000;
// Each check reuses the fixture, so only its own work counts against this budget.
const PACK_PHASE_TIMEOUT_MS = 60_000;

type PackedPackage = {
  name: (typeof PACKAGE_NAMES)[number];
  directory: string;
  version: string;
  archive: string;
  extracted: string;
  members: Array<string>;
};

type PackFixture = {
  root: string;
  consumer: string;
  stagedCoreIdentityUrl: string;
  sourceSnapshots: Array<{ directory: string; manifest: string; identity: string }>;
  core: PackedPackage;
  cli: PackedPackage;
};

let fixture: PackFixture | undefined;

function packedFixture() {
  if (fixture === undefined) {
    throw new Error("The pack fixture did not run.");
  }
  return fixture;
}

function run(command: string[], cwd: string, env = TEST_ENVIRONMENT) {
  const result = Bun.spawnSync(command, { cwd, env });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

/** Copies the working tree, packs both packages and extracts them into a consumer layout. */
function createPackFixture(): PackFixture {
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

    const packages = new Map<PackedPackage["name"], PackedPackage>();
    for (const name of PACKAGE_NAMES) {
      const directory = join(root, "packages", name);
      const sourceManifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const version = sourceManifest.version;
      const stagingDirectory = join(directory, sourceManifest.publishConfig.directory);
      // Packing must build, even when a previous output is incomplete.
      mkdirSync(stagingDirectory, { recursive: true });
      writeFileSync(join(stagingDirectory, "obsolete.js"), "throw new Error('stale release');");
      run(["pnpm", "pack", "--pack-destination", packDirectory], directory);
      const archive = join(packDirectory, `zinn-dev-${name}-${version}.tgz`);
      const members = run(["tar", "-tzf", archive], root).trim().split("\n");
      const extracted = join(consumer, name);
      mkdirSync(extracted);
      run(["tar", "-xzf", archive, "-C", extracted, "--strip-components=1"], root);
      if (name === "core") {
        symlinkSync(join(REPOSITORY_DIRECTORY, "packages", "core", "node_modules"), join(extracted, "node_modules"), "junction");
      } else {
        const cliManifest = JSON.parse(readFileSync(join(REPOSITORY_DIRECTORY, "packages/cli/package.json"), "utf8"));
        for (const [dependency, range] of Object.entries(cliManifest.dependencies)) {
          if (!String(range).startsWith("workspace:")) {
            const dependencyPath = join(extracted, "node_modules", dependency);
            mkdirSync(join(dependencyPath, ".."), { recursive: true });
            symlinkSync(join(REPOSITORY_DIRECTORY, "packages/cli/node_modules", dependency), dependencyPath, "junction");
          }
        }
      }
      packages.set(name, { name, directory, version, archive, extracted, members });
    }

    const core = packages.get("core");
    const cli = packages.get("cli");
    if (core === undefined || cli === undefined) {
      throw new Error("The fixture did not pack both packages.");
    }
    const coreManifest = JSON.parse(readFileSync(join(core.directory, "package.json"), "utf8"));
    const coreStagingDirectory = join(core.directory, coreManifest.publishConfig.directory);
    const stagedCoreIdentityUrl = pathToFileURL(join(coreStagingDirectory, "src/release-identity.js")).href;

    return { root, consumer, stagedCoreIdentityUrl, sourceSnapshots, core, cli };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

beforeAll(() => {
  fixture = createPackFixture();
}, PACK_FIXTURE_TIMEOUT_MS);

afterAll(() => {
  if (fixture !== undefined) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pnpm packs fresh JS artifacts with the declared files and leaves the source tree unchanged", () => {
  const { root, core, cli, sourceSnapshots } = packedFixture();

  for (const packed of [core, cli]) {
    const developmentIdentityUrl = pathToFileURL(join(packed.directory, "dist", "src/release-identity.js")).href;
    expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(developmentIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
    expect(packed.members).toContain("package/index.js");
    expect(packed.members).toContain("package/index.d.ts");
    expect(packed.members).toContain("package/README.md");
    expect(packed.members).toContain("package/LICENSE");
    expect(packed.members).toContain("package/src/release-identity.js");
    expect(packed.members.some((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))).toBe(false);
    expect(packed.members.some((path) => /node_modules|obsolete|release-stamp|AGENTS|NOTES|build\.test/.test(path))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(packed.extracted, "package.json"), "utf8"));
    expect(manifest.exports).toEqual({ ".": { types: "./index.d.ts", import: "./index.js" } });
    expect(manifest.types).toBe("./index.d.ts");
    expect(manifest).not.toHaveProperty("zinnRelease");
    expect(manifest.scripts).toBeUndefined();
  }

  expect(core.members.some((path) => /testing[./]|schema-snapshots|node\.check|sqlite\/contract\./.test(path))).toBe(false);
  expect(core.members).toContain("package/included.txt");
  expect(core.members).not.toContain("package/excluded.txt");
  expect(cli.members).toContain("package/skills/zinn/SKILL.md");

  const coreManifest = JSON.parse(readFileSync(join(core.directory, "package.json"), "utf8"));
  const packedCoreManifest = JSON.parse(readFileSync(join(core.extracted, "package.json"), "utf8"));
  expect(packedCoreManifest.imports["#sqlite"]).toEqual({ bun: "./src/sqlite/bun.js", default: "./src/sqlite/node.js" });
  const packedCliManifest = JSON.parse(readFileSync(join(cli.extracted, "package.json"), "utf8"));
  expect(packedCliManifest.dependencies["@zinn-dev/core"]).toBe(coreManifest.version);
  expect(packedCliManifest.dependencies.zod).toBe(coreManifest.dependencies.zod);
  expect(packedCliManifest.bin.zinn).toBe("./index.js");
  expect(readFileSync(join(cli.extracted, "index.js"), "utf8")).toStartWith("#!/usr/bin/env node");
  expect(readFileSync(join(cli.extracted, "skills/zinn/SKILL.md"))).toEqual(
    readFileSync(join(cli.directory, "skills/zinn/SKILL.md")),
  );

  for (const { directory, manifest, identity } of sourceSnapshots) {
    expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(manifest);
    expect(readFileSync(join(directory, "src/release-identity.ts"), "utf8")).toBe(identity);
  }
}, PACK_PHASE_TIMEOUT_MS);

function checkSourceCapabilities(root: string, cli: PackedPackage, suffix: string) {
  return checkCapabilityDiscovery({
    runtime: process.execPath,
    entryPoint: join(cli.directory, "index.ts"),
    packageDirectory: cli.directory,
    directory: join(root, `capabilities-source-${suffix}`), env: TEST_ENVIRONMENT,
  });
}

test("the source and development build discover the same capabilities", async () => {
  const { root, cli } = packedFixture();
  const sourceContract = await checkSourceCapabilities(root, cli, "build");
  await checkCapabilityDiscovery({
    runtime: process.execPath,
    entryPoint: join(cli.directory, "dist/index.js"),
    packageDirectory: join(cli.directory, "dist"),
    directory: join(root, "capabilities-build"), env: TEST_ENVIRONMENT, expected: sourceContract,
  });
}, PACK_PHASE_TIMEOUT_MS);

for (const runtime of ["bun", "node"] as const) {
  test(`${runtime}: the packed CLI discovers and consumes the source capabilities`, async () => {
    const { root, cli } = packedFixture();
    const sourceContract = await checkSourceCapabilities(root, cli, runtime);
    const contract = await checkCapabilityDiscovery({
      runtime: Bun.which(runtime)!, entryPoint: join(cli.extracted, "index.js"),
      packageDirectory: cli.extracted, directory: join(root, `capabilities-packed-${runtime}`),
      env: TEST_ENVIRONMENT, expected: sourceContract,
    });
    mkdirSync(join(root, `capabilities-consumer-${runtime}`));
    await checkCapabilityConsumer(contract, (args) => runCli(args, {
      runtime: Bun.which(runtime)!, cliPath: join(cli.extracted, "index.js"), cwd: root,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: join(root, `capabilities-consumer-${runtime}`), ZINN_DEBUG: undefined, DEBUG: undefined },
    }));
  }, PACK_PHASE_TIMEOUT_MS);
}

test("the packaged workflow skill's examples run against the packed CLI under Bun and Node", async () => {
  const { root, cli } = packedFixture();
  for (const runtime of ["bun", "node"]) {
    await checkSkillExamples({
      packageDirectory: cli.extracted,
      runtime: Bun.which(runtime)!,
      entryPoint: join(cli.extracted, "index.js"),
      directory: join(root, `skill-${runtime}`),
      env: TEST_ENVIRONMENT,
    });
  }
}, PACK_PHASE_TIMEOUT_MS);

test("the packed CLI parses timestamp inputs under Bun and Node", async () => {
  const { root, cli } = packedFixture();
  for (const runtime of ["bun", "node"]) {
    const timeOptions = {
      runtime: Bun.which(runtime)!, cliPath: join(cli.extracted, "index.js"), cwd: root,
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: join(root, `activity-time-${runtime}`), TZ: "America/New_York" },
    };
    mkdirSync(timeOptions.env.ZINN_DIR);
    const createdProject = await runCli(["project", "create", "CLOCK", "--json"], timeOptions);
    expect(createdProject.code, createdProject.stderr).toBe(0);
    const recorded = JSON.parse((await runCli(["activity", "list", "--json"], timeOptions)).stdout);
    const timestamp = recorded[0].created_at;
    const selected = await runCli(["activity", "list", "--since", new Date(timestamp).toISOString(), "--until", String(timestamp), "--json"], timeOptions);
    expect(selected.code, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout)).toEqual(recorded);
    const timeParserUrl = pathToFileURL(join(cli.extracted, "src/timestamp-input.js")).href;
    const timeCode = `
      const { timestampInputSchema: schema } = await import(${JSON.stringify(timeParserUrl)});
      console.log(JSON.stringify({
        fractions: ["1", "12", "123"].map(fraction => schema.parse("2026-10-25T13:00:00." + fraction + "+01:00")),
        invalid: ["2026-02-29T00:00:00Z", "2026-10-25T24:00:00Z", "2016-12-31T23:59:60Z", "2026-10-25T12:00:00.1234Z", "8640000000000001"].map(value => schema.safeParse(value).success)
      }));`;
    expect(JSON.parse(run([runtime, "--input-type=module", "--eval", timeCode], root, timeOptions.env))).toEqual({
      fractions: [1_792_929_600_100, 1_792_929_600_120, 1_792_929_600_123],
      invalid: [false, false, false, false, false],
    });
  }
}, PACK_PHASE_TIMEOUT_MS);

test("the packed packages report published identities", () => {
  const { root, core, cli, stagedCoreIdentityUrl } = packedFixture();
  // The CLI's core rebuild must leave the prepared core release intact.
  expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(stagedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("published");
  const identitiesCode = `Promise.all([
    import(${JSON.stringify(pathToFileURL(join(core.extracted, "src/release.js")).href)}),
    import(${JSON.stringify(pathToFileURL(join(cli.extracted, "src/database.js")).href)})
  ]).then(([core, cli]) => console.log(JSON.stringify({ core: core.readCoreReleaseMode(), cli: cli.getCliOpenPolicy().release })));`;
  for (const runtime of ["bun", "node"]) {
    expect(JSON.parse(run([runtime, "--eval", identitiesCode], root))).toEqual({ core: "published", cli: "published" });
  }
}, PACK_PHASE_TIMEOUT_MS);

test("the packed CLI protects databases and upgrades them across release combinations", () => {
  const { root, consumer } = packedFixture();
  // The check patches the packed registry and release identities, so it uses its own copy.
  const isolatedConsumer = join(root, "migration-consumer", "node_modules", "@zinn-dev");
  mkdirSync(isolatedConsumer, { recursive: true });
  for (const name of PACKAGE_NAMES) {
    cpSync(join(consumer, name), join(isolatedConsumer, name), { recursive: true, verbatimSymlinks: true });
  }
  const packedCore = join(isolatedConsumer, "core");
  const packedCli = join(isolatedConsumer, "cli");

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
    const env = { ...TEST_ENVIRONMENT, HOME: home, ZINN_DIR: store };
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
}, PACK_PHASE_TIMEOUT_MS);

test("rebuilding the CLI leaves the core release and source identities intact", () => {
  const { root, core, cli, stagedCoreIdentityUrl } = packedFixture();

  run(["bun", "run", "build"], cli.directory);
  expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(stagedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("published");
  for (const directory of [core.directory, cli.directory]) {
    const identityUrl = pathToFileURL(join(directory, "dist", "src/release-identity.js")).href;
    expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(identityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
    expect(readFileSync(join(directory, "src/release-identity.ts"), "utf8")).toContain('"source"');
  }
  const coreLink = join(cli.directory, "dist", "node_modules", "@zinn-dev", "core");
  const linkedCoreIdentityUrl = pathToFileURL(join(coreLink, "src/release-identity.js")).href;
  expect(run(["bun", "--eval", `console.log((await import(${JSON.stringify(linkedCoreIdentityUrl)})).RELEASE_MODE)`], root).trim()).toBe("source");
}, PACK_PHASE_TIMEOUT_MS);
