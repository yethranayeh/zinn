import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "./package.json";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = join(packageDirectory, "dist");

rmSync(outputDirectory, { recursive: true, force: true });

const result = Bun.spawnSync(["bunx", "--no-install", "tsc", "-p", "tsconfig.build.json"], {
  cwd: packageDirectory,
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

// Keep emitted adapter resolution inside the output instead of reaching source TypeScript.
const imports = Object.fromEntries(
  Object.entries(packageJson.imports).map(([name, conditions]) => [
    name,
    Object.fromEntries(
      Object.entries(conditions).map(([condition, target]) => [
        condition,
        target.replace(/\.ts$/, ".js"),
      ]),
    ),
  ]),
);

writeFileSync(
  join(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      type: "module",
      imports,
      exports: {
        ".": {
          types: "./index.d.ts",
          import: "./index.js",
        },
      },
    },
    null,
    2,
  )}\n`,
);
