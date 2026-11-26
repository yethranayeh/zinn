/**
 * Builds the site or Foundry into a new temporary folder, runs its tests against that folder,
 *  and deploys it from there, so no other build in docs/ can change what is uploaded.
 * Usage: bun scripts/deploy.ts <site|foundry> [wrangler deploy flags]
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");

// Foundry's own tests. The site deploy runs every other test, and the Foundry deploy runs
//  these plus the shared component rules.
const foundryTestFile = "foundry.test.ts";
const componentTestFile = "components.test.ts";

const siteTests = [
  "worker",
  ...[...new Bun.Glob("*.test.ts").scanSync({ cwd: join(docsDirectory, "tests") })]
    .filter((file) => file !== foundryTestFile)
    .map((file) => `./tests/${file}`),
];

const targets = {
  site: {
    config: "wrangler.jsonc",
    // Wrangler publishes exactly the files it finds, so an empty or partial folder would replace the live site.
    requiredFiles: [
      "index.html",
      "404.html",
      "index.md",
      "llms.txt",
      "sitemap-index.xml",
      "pagefind/pagefind.js",
    ],

    async build(directory: string) {
      await run(["--bun", "astro", "build", "--outDir", directory], {
        PUBLIC_SITE_ENV: "production",
      });

      await run(["x", "pagefind", "--site", directory]);

      if (existsSync(join(docsDirectory, "steerdown.graph.json"))) {
        await run(["x", "steerdown", "emit", "--html", directory]);
      }
    },

    async test(directory: string) {
      await run(["tests/run.ts", ...siteTests], { SITE_BUILD_DIRECTORY: directory });
    },
  },
  foundry: {
    config: "wrangler.foundry.jsonc",
    requiredFiles: ["index.html"],

    async build(directory: string) {
      await run(["--bun", "astro", "build", "--config", "foundry.config.mjs", "--outDir", directory]);
    },

    async test(directory: string) {
      await run(["test", `./tests/${foundryTestFile}`, `./tests/${componentTestFile}`], {
        FOUNDRY_BUILD_DIRECTORY: directory,
      });
    },
  },
};

const [targetName, ...wranglerFlags] = process.argv.slice(2);
if (targetName !== "site" && targetName !== "foundry") {
  console.error("Usage: bun scripts/deploy.ts <site|foundry> [wrangler deploy flags]");
  process.exit(2);
}
const target = targets[targetName];

async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, ...command], {
    cwd: docsDirectory,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    throw new Error(`bun ${command.join(" ")} exited with ${exitCode}`);
  }
}

const buildDirectory = await mkdtemp(join(tmpdir(), "zinn-site-deploy-"));

try {
  await target.build(buildDirectory);
  await target.test(buildDirectory);

  const missingFiles = target.requiredFiles.filter(
    (file) => !existsSync(join(buildDirectory, file)),
  );

  if (missingFiles.length > 0) {
    throw new Error(`Not deploying: ${buildDirectory} is missing ${missingFiles.join(", ")}`);
  }

  await run([
    "x",
    "wrangler",
    "deploy",
    "--config",
    target.config,
    "--assets",
    buildDirectory,
    ...wranglerFlags,
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}
