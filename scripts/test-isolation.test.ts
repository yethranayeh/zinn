import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHED_STAMP, RELEASE_STAMP_FILE } from "../packages/core/src/release.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const packageNames = readdirSync(join(REPOSITORY_DIRECTORY, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const cases = [
  { name: "a clean checkout", packageName: null, version: "1.0.0" },
  ...packageNames.flatMap((packageName) =>
    ["1.0.0", "1.1.0-dev"].map((version) => ({
      name: `a stamp in ${packageName} at ${version}`,
      packageName,
      version,
    })),
  ),
];

test.each(cases)("test preload with $name", ({ packageName, version }) => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-test-isolation-"));

  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "temp"));
    mkdirSync(join(directory, "packages", "core", "src"), { recursive: true });
    for (const path of ["scripts/test-isolation.ts", "packages/core/src/release.ts"]) {
      copyFileSync(join(REPOSITORY_DIRECTORY, path), join(directory, path));
    }
    writeFileSync(join(directory, "bunfig.toml"), '[test]\npreload = ["./scripts/test-isolation.ts"]\n');
    writeFileSync(join(directory, "probe.test.ts"), `
      import { expect, test } from "bun:test";
      import { writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      test("the preload isolates the database before tests run", () => {
        expect(process.env.ZINN_DIR?.startsWith(join(tmpdir(), "zinn-test-run-"))).toBe(true);
        writeFileSync("test-ran", process.env.ZINN_DIR!);
      });
    `);

    const stamp = JSON.stringify(PUBLISHED_STAMP);
    const stampPath = packageName === null ? null : join(directory, "packages", packageName, RELEASE_STAMP_FILE);
    if (stampPath !== null) {
      mkdirSync(dirname(stampPath), { recursive: true });
      writeFileSync(join(dirname(stampPath), "package.json"), JSON.stringify({ version }));
      writeFileSync(stampPath, stamp);
    }

    const result = Bun.spawnSync([process.execPath, "test", "./probe.test.ts"], {
      cwd: directory,
      env: { ...process.env, TMPDIR: join(directory, "temp"), ZINN_DIR: join(directory, "inherited-store") },
    });
    const testMarker = join(directory, "test-ran");

    if (stampPath === null) {
      expect(result.exitCode).toBe(0);
      expect(existsSync(testMarker)).toBe(true);
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(testMarker)).toBe(false);
      expect(result.stderr.toString()).toContain(stampPath);
      expect(result.stderr.toString()).toContain("bun ../../scripts/release-stamp.ts remove");
      expect(readFileSync(stampPath, "utf8")).toBe(stamp);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
