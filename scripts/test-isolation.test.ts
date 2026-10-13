import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_IDENTITY_MODULES } from "./test-isolation.ts";

const REPOSITORY_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const packageNames = SOURCE_IDENTITY_MODULES.map((identity) => identity.name);
const additionalPackage = "additional-client";
const cases = [
  { name: "a clean source checkout", published: [] },
  ...packageNames.map((name) => ({ name: `published ${name} source`, published: [name] })),
  { name: "all published sources", published: packageNames },
  { name: "an additional published client", published: [additionalPackage] },
];

test.each(cases)("test preload with $name", ({ published }) => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-test-isolation-"));

  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "temp"));
    copyFileSync(join(REPOSITORY_DIRECTORY, "scripts/test-isolation.ts"), join(directory, "scripts/test-isolation.ts"));
    for (const name of [...packageNames, additionalPackage]) {
      const sourceDirectory = join(directory, "packages", name, "src");
      const outputDirectory = join(directory, "packages", name, "dist", "src");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(join(sourceDirectory, "release-identity.ts"), `export const RELEASE_MODE = "${published.includes(name) ? "published" : "source"}";\n`);
      writeFileSync(join(outputDirectory, "release-identity.js"), 'export const RELEASE_MODE = "published";\n');
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

    const result = Bun.spawnSync([process.execPath, "test", "./probe.test.ts"], {
      cwd: directory,
      env: { ...process.env, TMPDIR: join(directory, "temp"), ZINN_DIR: join(directory, "inherited-store") },
    });

    if (published.length === 0) {
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(directory, "test-ran"))).toBe(true);
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(directory, "test-ran"))).toBe(false);
      expect(result.stderr.toString()).toContain("release-identity.ts");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
