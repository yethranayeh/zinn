import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cliPackageJson from "../packages/cli/package.json";

const SCRIPT = fileURLToPath(new URL("prepare-release.ts", import.meta.url));
const SOURCE_IDENTITY = 'export const RELEASE_MODE = "source";\n';
const STAGING_DIRECTORY = cliPackageJson.publishConfig.directory;
const PREPARATION_ENV = { ...process.env, npm_config_user_agent: "pnpm/test" };

function readOutputIdentity(directory: string, outputName = "dist") {
  const identityUrl = pathToFileURL(join(directory, outputName, "src", "release-identity.js")).href;
  const result = Bun.spawnSync(["bun", "--eval", `console.log((await import(${JSON.stringify(identityUrl)})).RELEASE_MODE)`]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

const cases = [
  { name: "plain versions", cliVersion: "0.40.0", coreVersion: "0.29.0", offenders: [] },
  { name: "a prerelease CLI", cliVersion: "0.40.0-dev", coreVersion: "0.29.0", offenders: ["@zinn-dev/cli 0.40.0-dev"] },
  { name: "a prerelease core", cliVersion: "0.40.0", coreVersion: "0.29.0-dev", offenders: ["@zinn-dev/core 0.29.0-dev"] },
  { name: "both prereleases", cliVersion: "0.40.0-dev", coreVersion: "0.29.0-dev", offenders: ["@zinn-dev/cli 0.40.0-dev", "@zinn-dev/core 0.29.0-dev"] },
];

function withFixture(cliVersion: string, coreVersion: string, check: (directory: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "zinn-prepare-release-"));
  const directory = join(root, "packages", "cli");

  try {
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "@zinn-dev/core", version: coreVersion }));
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "@zinn-dev/cli", version: cliVersion, dependencies: { "@zinn-dev/core": "workspace:*" }, scripts: { build: "bun build.ts" },
    }));
    writeFileSync(join(directory, "src", "release-identity.ts"), SOURCE_IDENTITY);
    writeFileSync(join(directory, "build.ts"), `
      import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
      rmSync("dist", { recursive: true, force: true });
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/package.json", JSON.stringify({ name: "@zinn-dev/cli", version: ${JSON.stringify(cliVersion)} }));
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
      mkdirSync("dist/node_modules/@zinn-dev", { recursive: true });
      symlinkSync(${JSON.stringify(join(root, "packages", "core"))}, "dist/node_modules/@zinn-dev/core", "junction");
    `);
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "old-release"), "existing development output");
    mkdirSync(join(directory, "dist", "node_modules", "@zinn-dev"), { recursive: true });
    symlinkSync(join(root, "packages", "core"), join(directory, "dist", "node_modules", "@zinn-dev", "core"), "junction");
    mkdirSync(join(directory, "dist", "src"));
    writeFileSync(join(directory, "dist", "src", "release-identity.js"), SOURCE_IDENTITY);
    mkdirSync(join(directory, STAGING_DIRECTORY, "src"), { recursive: true });
    writeFileSync(join(directory, STAGING_DIRECTORY, "src", "release-identity.js"), 'export const RELEASE_MODE = "published";\n');
    writeFileSync(join(directory, STAGING_DIRECTORY, "old-release"), "existing staged output");
    check(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(cases)("release preparation with $name", ({ cliVersion, coreVersion, offenders }) => {
  withFixture(cliVersion, coreVersion, (directory) => {
    const sourceManifest = readFileSync(join(directory, "package.json"), "utf8");
    const coreLink = join(directory, "dist", "node_modules", "@zinn-dev", "core");
    const coreLinkTarget = readlinkSync(coreLink);
    const result = Bun.spawnSync(["bun", SCRIPT], { cwd: directory, env: PREPARATION_ENV });
    expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(sourceManifest);
    expect(readFileSync(join(directory, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
    expect(readOutputIdentity(directory)).toBe("source");
    expect(readlinkSync(coreLink)).toBe(coreLinkTarget);

    if (offenders.length === 0) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(existsSync(join(directory, "dist", "old-release"))).toBe(false);
      expect(existsSync(join(directory, STAGING_DIRECTORY, "node_modules"))).toBe(false);
      expect(existsSync(join(directory, STAGING_DIRECTORY, "old-release"))).toBe(false);
      expect(readOutputIdentity(directory, STAGING_DIRECTORY)).toBe("published");
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(directory, "dist", "old-release"), "utf8")).toBe("existing development output");
      expect(readFileSync(join(directory, STAGING_DIRECTORY, "old-release"), "utf8")).toBe("existing staged output");
      for (const offender of offenders) {
        expect(result.stderr.toString()).toContain(offender);
      }
    }
  });
});

test("a failed release build removes staging and leaves development identity source", () => {
  withFixture("0.40.0", "0.29.0", (directory) => {
    writeFileSync(join(directory, "build.ts"), `
      import { mkdirSync, rmSync, writeFileSync } from "node:fs";
      rmSync("dist", { recursive: true, force: true });
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
      process.exit(1);
    `);
    const result = Bun.spawnSync(["bun", SCRIPT], { cwd: directory, env: PREPARATION_ENV });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(directory, STAGING_DIRECTORY))).toBe(false);
    expect(readOutputIdentity(directory)).toBe("source");
    expect(readFileSync(join(directory, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
  });
});

test("an interrupted preparation leaves source identity and the next build starts fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-interrupted-release-"));

  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "release-identity.ts"), SOURCE_IDENTITY);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-client", version: "1.0.0", scripts: { build: "bun build.ts" } }));
    writeFileSync(join(root, "build.ts"), `
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
      writeFileSync("dist/package.json", '{"version":"1.0.0"}');
      process.kill(Number(readFileSync("prepare.pid", "utf8")), "SIGKILL");
    `);
    const preparation = Bun.spawn(["bun", SCRIPT], { cwd: root, env: PREPARATION_ENV, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(root, "prepare.pid"), String(preparation.pid));
    expect(await preparation.exited).not.toBe(0);
    await Promise.all([new Response(preparation.stdout).text(), new Response(preparation.stderr).text()]);
    expect(readFileSync(join(root, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
    expect(readOutputIdentity(root)).toBe("source");
    expect(existsSync(join(root, STAGING_DIRECTORY))).toBe(false);

    writeFileSync(join(root, "build.ts"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
      writeFileSync("dist/package.json", '{"version":"1.0.0"}');
    `);
    const repeated = Bun.spawnSync(["bun", SCRIPT], { cwd: root, env: PREPARATION_ENV });
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
    expect(readOutputIdentity(root)).toBe("source");
    expect(readOutputIdentity(root, STAGING_DIRECTORY)).toBe("published");
    expect(readFileSync(join(root, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "npm", userAgent: "npm/11.15.0 node/v24.7.0" },
  { name: "Bun", userAgent: "bun/1.3.14 npm/? node/v24.3.0" },
  { name: "a direct invocation", userAgent: undefined },
])("release preparation refuses $name without changing output", ({ userAgent }) => {
  withFixture("0.40.0", "0.29.0", (directory) => {
    const coreLink = join(directory, "dist", "node_modules", "@zinn-dev", "core");
    const coreLinkTarget = readlinkSync(coreLink);
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: directory,
      env: { ...PREPARATION_ENV, npm_config_user_agent: userAgent },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("pnpm pack");
    expect(result.stderr.toString()).toContain("pnpm publish");
    expect(readFileSync(join(directory, "dist", "old-release"), "utf8")).toBe("existing development output");
    expect(readlinkSync(coreLink)).toBe(coreLinkTarget);
    expect(readOutputIdentity(directory)).toBe("source");
    expect(readFileSync(join(directory, STAGING_DIRECTORY, "old-release"), "utf8")).toBe("existing staged output");
  });
});

test("interruption after stamping staging cannot publish development identity", () => {
  withFixture("0.40.0", "0.29.0", (directory) => {
    const wrapper = join(directory, "interrupt-staging.ts");
    writeFileSync(wrapper, `
      await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
      process.kill(process.pid, "SIGKILL");
    `);
    const result = Bun.spawnSync(["bun", wrapper], { cwd: directory, env: PREPARATION_ENV });
    expect(result.exitCode).not.toBe(0);
    expect(result.signalCode).toBe("SIGKILL");
    expect(existsSync(join(directory, STAGING_DIRECTORY, "old-release"))).toBe(false);
    expect(readOutputIdentity(directory, STAGING_DIRECTORY)).toBe("published");
    expect(readOutputIdentity(directory)).toBe("source");
    expect(readFileSync(join(directory, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
    expect(readlinkSync(join(directory, "dist", "node_modules", "@zinn-dev", "core"))).toBe(join(directory, "..", "core"));
    expect(existsSync(join(directory, STAGING_DIRECTORY, "node_modules"))).toBe(false);

    writeFileSync(join(directory, STAGING_DIRECTORY, "obsolete.js"), "stale output");
    const repeated = Bun.spawnSync(["bun", SCRIPT], { cwd: directory, env: PREPARATION_ENV });
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
    expect(existsSync(join(directory, STAGING_DIRECTORY, "obsolete.js"))).toBe(false);
    expect(readOutputIdentity(directory)).toBe("source");
    expect(readOutputIdentity(directory, STAGING_DIRECTORY)).toBe("published");
  });
});
