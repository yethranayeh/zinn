import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_STAMP_FILE } from "../packages/core/src/release.ts";

const SCRIPT = fileURLToPath(new URL("release-stamp.ts", import.meta.url));

const cases = [
  { name: "plain versions", cliVersion: "0.38.0", coreVersion: "0.27.0", offenders: [] },
  { name: "a prerelease CLI", cliVersion: "0.39.0-dev", coreVersion: "0.27.0", offenders: ["@zinn-dev/cli 0.39.0-dev"] },
  { name: "a prerelease core", cliVersion: "0.39.0", coreVersion: "0.28.0-dev", offenders: ["@zinn-dev/core 0.28.0-dev"] },
  {
    name: "both prereleases",
    cliVersion: "0.39.0-dev",
    coreVersion: "0.28.0-dev",
    offenders: ["@zinn-dev/cli 0.39.0-dev", "@zinn-dev/core 0.28.0-dev"],
  },
];

function writePackage(directory: string, manifest: object) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
}

/** Runs `write` in a CLI package folder that has core next to it, as in packages/. */
function writeStamp(cliVersion: string, coreVersion: string) {
  const root = mkdtempSync(join(tmpdir(), "zinn-release-stamp-"));
  const cliDirectory = join(root, "packages", "cli");

  try {
    writePackage(join(root, "packages", "core"), { name: "@zinn-dev/core", version: coreVersion });
    writePackage(cliDirectory, {
      name: "@zinn-dev/cli",
      version: cliVersion,
      dependencies: { "@zinn-dev/core": "workspace:*" },
    });

    const result = Bun.spawnSync(["bun", SCRIPT, "write"], { cwd: cliDirectory });

    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      hasStamp: existsSync(join(cliDirectory, RELEASE_STAMP_FILE)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(cases)("write with $name", ({ cliVersion, coreVersion, offenders }) => {
  const result = writeStamp(cliVersion, coreVersion);

  if (offenders.length === 0) {
    expect(result.exitCode).toBe(0);
    expect(result.hasStamp).toBe(true);
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(result.hasStamp).toBe(false);

    for (const offender of offenders) {
      expect(result.stderr).toContain(offender);
    }
  }
});
