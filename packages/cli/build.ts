import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "./package.json";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const coreDirectory = fileURLToPath(new URL("../core", import.meta.url));
const outputDirectory = join(packageDirectory, "dist");

rmSync(outputDirectory, { recursive: true, force: true });

for (const command of [
  ["bun", "run", "--cwd", coreDirectory, "build"],
  ["bunx", "--no-install", "tsc", "-p", "tsconfig.build.json"],
]) {
  const result = Bun.spawnSync(command, {
    cwd: packageDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

writeFileSync(
  join(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: packageJson.name,
      version: packageJson.version,
      type: "module",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      bin: { zinn: "./index.js" },
    },
    null,
    2,
  )}\n`,
);

// Only the emitted executable uses the Node shebang.
const executablePath = join(outputDirectory, "index.js");
const executable = readFileSync(executablePath, "utf8");
writeFileSync(executablePath, executable.replace(/^#!\/usr\/bin\/env bun/, "#!/usr/bin/env node"));
chmodSync(executablePath, 0o755);

// Local development consumes core as a separate built dependency.
const dependencyScope = join(outputDirectory, "node_modules", "@zinn-dev");
mkdirSync(dependencyScope, { recursive: true });
symlinkSync(join(coreDirectory, "dist"), join(dependencyScope, "core"), "junction");
