import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("prepare-release.ts", import.meta.url));
const SOURCE_IDENTITY = 'export const RELEASE_MODE = "source";\n';
function readOutputIdentity(directory: string) {
  const identityUrl = pathToFileURL(join(directory, "dist", "src", "release-identity.js")).href;
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
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/package.json", JSON.stringify({ name: "@zinn-dev/cli", version: ${JSON.stringify(cliVersion)} }));
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
    `);
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "old-release"), "existing development output");
    mkdirSync(join(directory, "dist", "node_modules", "@zinn-dev"), { recursive: true });
    symlinkSync(join(root, "packages", "core"), join(directory, "dist", "node_modules", "@zinn-dev", "core"), "junction");
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
    const result = Bun.spawnSync(["bun", SCRIPT], { cwd: directory });
    expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(sourceManifest);
    expect(readFileSync(join(directory, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);

    if (offenders.length === 0) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(existsSync(join(directory, "dist", "old-release"))).toBe(false);
      expect(existsSync(coreLink)).toBe(false);
      expect(readOutputIdentity(directory)).toBe("published");
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(directory, "dist", "old-release"), "utf8")).toBe("existing development output");
      expect(readlinkSync(coreLink)).toBe(coreLinkTarget);
      for (const offender of offenders) {
        expect(result.stderr.toString()).toContain(offender);
      }
    }
  });
});

test("a failed release build removes partial output and preserves source identity", () => {
  withFixture("0.40.0", "0.29.0", (directory) => {
    writeFileSync(join(directory, "build.ts"), 'import { mkdirSync } from "node:fs"; mkdirSync("dist"); process.exit(1);');
    const result = Bun.spawnSync(["bun", SCRIPT], { cwd: directory });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(directory, "dist"))).toBe(false);
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
    const preparation = Bun.spawn(["bun", SCRIPT], { cwd: root, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(root, "prepare.pid"), String(preparation.pid));
    expect(await preparation.exited).not.toBe(0);
    await Promise.all([new Response(preparation.stdout).text(), new Response(preparation.stderr).text()]);
    expect(readFileSync(join(root, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
    expect(readOutputIdentity(root)).toBe("source");

    writeFileSync(join(root, "build.ts"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/src/release-identity.js", ${JSON.stringify(SOURCE_IDENTITY)});
      writeFileSync("dist/package.json", '{"version":"1.0.0"}');
    `);
    const repeated = Bun.spawnSync(["bun", SCRIPT], { cwd: root });
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
    expect(readOutputIdentity(root)).toBe("published");
    expect(readFileSync(join(root, "src", "release-identity.ts"), "utf8")).toBe(SOURCE_IDENTITY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
